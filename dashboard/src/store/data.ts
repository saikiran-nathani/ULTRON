/**
 * The whole `NexusData` blob, and the only place it is written.
 *
 * Ported from nexus, with one structural change: there are now **two** ways
 * the data can move, and they are separate functions rather than one function
 * with a flag.
 *
 * - `update(recipe)` — a person did something. Mutate, persist, and tell the
 *   sync bridge there is something to push.
 * - `adopt(blob)` — sync produced a merged blob. Replace, persist, and tell
 *   **nobody**.
 *
 * That split is the whole of the loop prevention, and the loop is worth
 * spelling out because the naive wiring is one line and its symptoms are
 * indistinguishable from a busy network:
 *
 *     pull → write() → store changes → save → "something changed, sync!"
 *          → cycle → pull → write() → …
 *
 * Every lap burns a server `seq`, re-delivers the record to all five devices,
 * and each of those devices does the same. It never terminates and it never
 * errors. Three independent things stop it here:
 *
 * 1. **Structure.** `adopt` cannot reach the edit listeners. There is no
 *    argument it can be called with that notifies them — as opposed to
 *    `update(recipe, { fromSync: true })`, which is a parameter somebody
 *    forgets at one of twelve call sites.
 * 2. **Origin tracking**, for the path structure cannot see: a store
 *    subscriber that reacts to adopted data by calling `update` — a screen
 *    normalising, a slice deriving. That `update` is a genuine local edit as
 *    far as it knows, so it announces one, and the lap closes. So each
 *    `update` records whether it happened inside an adopt, and the debounced
 *    notification honours that record. It is deliberately *not* a
 *    "are we adopting?" check at notification time: the first version of this
 *    was exactly that, and it never fired, because `adopt` notifies
 *    synchronously while `update` announces 250ms later — by which point the
 *    answer is always no. A re-entrant edit is still applied and still cached;
 *    it simply does not ask for a cycle it did not cause.
 * 3. **`adopt` stores the blob verbatim.** This one is the quiet one, and it
 *    is a property of this file that the engine depends on. After `write()`
 *    the engine advances its baseline to *exactly* the blob it handed over, so
 *    a spurious cycle diffs to empty and pushes nothing — the engine's own
 *    protection, and it holds only if what we store matches what it sent. Run
 *    the blob through `normalize()` on the way in and the store disagrees with
 *    the baseline by whatever normalise touched, so the cycle after every pull
 *    pushes that difference: a pull answered with a push, on all five devices.
 *    It converges once the server has been taught each filled-in field, so
 *    this is a bounded wrong rather than an unbounded one — except where two
 *    builds disagree about what normalise produces, and `schemaVersion` is
 *    exactly such a field, at which point the two push at each other
 *    indefinitely. Normalising belongs on load (`db.ts`), where it happens
 *    once. `bridge.ts` makes one deliberate exception, for the blob that ends
 *    a recovery, and explains itself there.
 *
 * Which is also why `adopt` hands `set` an **object** and not a recipe.
 * zustand's immer middleware only routes *function* updaters through
 * `produce`, and immer 11 auto-freezes — deep, and on the original reference,
 * not a copy. Assigning the blob inside a draft would therefore freeze an
 * object this store does not own, as a side effect, on a value the caller
 * built. The object form skips `produce` entirely and stores the reference it
 * was given, which is the literal reading of "verbatim".
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { NexusData } from "@/lib/nexus/types";
import { loadData, saveData, type Cached } from "@/lib/nexus/db";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface DataState {
  data: NexusData | null;
  loaded: boolean;
  /**
   * False when the local cache missed on load — first run, or an iOS eviction.
   * The app is rendering defaults that are **not** a record of anything, and
   * the bridge must not let them be pushed until the server has been asked.
   */
  cacheHit: boolean;
  error: string | null;
  saveStatus: SaveStatus;
  /** Read the cache. Returns what it found, because the bridge needs `hit`. */
  load: () => Promise<Cached>;
  /** A person edited something: mutate the blob (Immer) and schedule a push. */
  update: (recipe: (d: NexusData) => void) => void;
  /** Sync merged something: take the blob, cache it, and stay quiet. */
  adopt: (blob: NexusData) => void;
  /** Persist now, cancelling any pending debounce. Called when the app hides. */
  flush: () => void;
}

/** Keystrokes settle into one save, and therefore into one sync nudge. */
export const SAVE_DEBOUNCE_MS = 250;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/* ── "a person edited something" ──────────────────────────────────────────
   A separate channel from the store's own subscribers, which fire for any
   change including an adopt. The bridge listens here and nowhere else. */

const editListeners = new Set<() => void>();

/** True only for the synchronous body of `adopt`. */
let adopting = false;

/**
 * Whether the armed save carries at least one edit a *person* made.
 *
 * This is layer 2, and it is a flag on the pending work rather than a check at
 * notification time — which is the correction to an earlier version of this
 * file that read `adopting` inside the timer and was useless. `adopt` notifies
 * its subscribers synchronously, so a subscriber's `update` runs inside the
 * adopt window; but that `update`'s notification is *debounced*, and by the
 * time it fires the window has long closed. The flag has to be set where the
 * origin is still known and read where the decision is made.
 *
 * Not a counter and not a reset-to-adopt: several `update` calls coalesce into
 * one save, and if any one of them was a genuine edit the notification must
 * happen. A pull landing mid-keystroke must not swallow the keystroke.
 */
let pendingUserEdit = false;

/** Subscribe to local edits. Returns an unsubscribe. */
export function onLocalEdit(fn: () => void): () => void {
  editListeners.add(fn);
  return () => void editListeners.delete(fn);
}

function notifyEdit(): void {
  // A copy of the set, because a listener may unsubscribe from inside its own
  // callback and mutating mid-iteration silently skips the next one.
  for (const fn of [...editListeners]) fn();
}

export const useData = create<DataState>()(
  immer((set, get) => {
    /** Persist, and report. Shared by the debounce and by `flush`. */
    const persist = (): void => {
      const data = get().data;
      if (!data) return;
      const ok = saveData(data);
      set((s) => void (s.saveStatus = ok ? "saved" : "error"));
    };

    return {
      data: null,
      loaded: false,
      cacheHit: false,
      error: null,
      saveStatus: "idle",

      async load() {
        try {
          const cached = await loadData();
          set((s) => {
            // Cast as nexus did: a `Draft<NexusData>` is not a `NexusData`,
            // and the draft of a whole-tree assignment is the one place that
            // distinction buys nothing.
            s.data = cached.data as NexusData;
            s.loaded = true;
            s.cacheHit = cached.hit;
            s.error = cached.corrupt
              ? "the local cache was unreadable and was ignored"
              : null;
          });
          return cached;
        } catch (e) {
          // A throw here is a bug rather than a missing cache — `loadData`
          // already swallows every storage fault. Surfaced rather than
          // swallowed, but the app still boots: `data` stays null and the
          // screens render their empty states.
          set((s) => {
            s.error = String(e);
            s.loaded = true;
          });
          throw e;
        }
      },

      update(recipe) {
        // Recorded here, while the origin is still known. An `update` running
        // inside an adopt is a subscriber reacting to merged data, not somebody
        // typing, and announcing it is the lap that closes the loop.
        if (!adopting) pendingUserEdit = true;
        set((s) => {
          if (s.data) recipe(s.data as NexusData);
          s.saveStatus = "saving";
        });
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          saveTimer = null;
          persist();
          // After the save, not before: a nudge that raced the cache write
          // would have sync read a blob the next reload could not reproduce.
          if (pendingUserEdit) {
            pendingUserEdit = false;
            notifyEdit();
          }
        }, SAVE_DEBOUNCE_MS);
      },

      adopt(blob) {
        adopting = true;
        try {
          // The object form, deliberately — see the module docstring's last
          // paragraph. `cacheHit` is also not touched here: it is a fact about
          // what the last `load` found, and whether recovery is over is the
          // bridge's judgement, made from the engine's replies.
          set({ data: blob, loaded: true });
          // Cached immediately rather than through the debounce. The engine
          // advances its cursor right after this returns, so a pull whose blob
          // never reached storage would leave the next boot showing an empty
          // app that believes it is up to date and will never ask for those
          // records again. It also must not disturb a pending user save: that
          // timer still holds an edit, and `get().data` when it fires is this
          // blob plus that edit, which is exactly what should be written.
          persist();
        } finally {
          adopting = false;
        }
      },

      flush() {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        persist();
        // Unconditional, unlike the debounce above. `flush` is called when the
        // app hides, which on iOS may be the last code that runs before the tab
        // is discarded — so this is the most important nudge there is, and a
        // cycle with nothing to offer costs one request. It is also never
        // reachable *from* an adopt, so it cannot be a lap of the loop.
        pendingUserEdit = false;
        notifyEdit();
      },
    };
  }),
);
