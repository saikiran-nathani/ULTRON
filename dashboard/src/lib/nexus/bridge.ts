/**
 * Stage 4's join: the app's blob on one side, `SyncEngine` on the other.
 *
 * The engine already does all of the hard work — it owns a baseline, a clock,
 * a cursor, a quarantine list and the order the three move in. It asks for two
 * functions over the app's state:
 *
 *     read()  →  the blob as it stands now
 *     write(b) →  this is the merged blob, take it
 *
 * Which looks like a morning's work and contains two ways to destroy a
 * dataset. Both come from the same root: **`read()` returning a blob that is
 * not this device's record of anything.**
 *
 * 1. **The eviction.** iOS discards a PWA's storage after ~7 days unopened —
 *    wholesale, silently, on the device most likely to go a week unopened. So
 *    an empty local store is a routine event on a device whose data is
 *    perfectly intact on the server. A `read()` that answers with an empty
 *    blob while the engine still holds a baseline produces a diff of
 *    *every record the device ever pushed, as a deletion*. The cycle pushes a
 *    few hundred tombstones, the server accepts them — they are well-formed,
 *    correctly clocked, authoritative writes — and the other four devices
 *    delete the dataset on their next pull. Nothing errors. Nothing is
 *    recoverable except from the server's archive, by hand.
 *
 * 2. **The reseed.** The opposite answer is no better. `read()` returning
 *    `makeDefaultData()` — which is what the screens need to render, so it is
 *    what the store holds — diffs against an empty baseline as ~90 *creations*
 *    of pristine seed content. The roadmap seed's ids are content-derived, so
 *    those records converge onto the real rows rather than duplicating them,
 *    which sounds like the safe outcome and is worse than duplication: each is
 *    a later write to a row the user has since edited on another device, so
 *    every ticked task and every rated layer reverts to its factory text.
 *
 * There is no value `read()` can return that is safe for an arbitrary
 * baseline, so the fix is not a better return value. It is that a device with
 * no record of its own **does not participate in the diff at all** until the
 * server has answered:
 *
 * - The sync state that describes what this device holds — cursor, baseline,
 *   joined — is discarded when the cache missed, because it describes a device
 *   that no longer exists. Kept, it is the tombstone catastrophe above; kept
 *   with a *cursor*, it is the quieter half — a cursor of 500 tells the server
 *   never to resend rows 1–500, and the recovering device stays empty forever
 *   while reporting a clean sync. The clock and the device id are deliberately
 *   *not* discarded: a re-minted clock publishes readings below ones this node
 *   has already published, and a new device id pins the server's tombstone-GC
 *   watermark at zero forever (see `clock.ts`).
 * - `read()` then offers nothing but `schemaVersion` until the first `write()`
 *   or an empty-server verdict. One record, no user data, no tombstones.
 *
 * `mayBootstrap(head, pulled)` decides which of those two endings applies, and
 * it is the engine's call rather than this file's: "a device whose first pull
 * returns anything never bootstraps". An empty server means we are the first
 * device and our defaults are the seed. A populated one means adopt, never
 * seed — which is the same test that stops a *second* device duplicating the
 * roadmap, and the reason it works for eviction too.
 *
 * The loop
 * --------
 * The other thing this file must not do is let `write()` cause a sync. See
 * `store/data.ts` for the three layers that stop it; the one that lives here
 * is that the bridge listens to a channel (`onLocalEdit`) that `adopt()`
 * cannot reach, and stops listening to it for the duration of a `write()`.
 */
import {
  SYNC_KEYS,
  SyncEngine,
  type EngineDeps,
  type EventSourceLike,
  type FetchLike,
  type SyncStatus,
} from "@/lib/sync/engine";
import { NEXUS_REGISTRY, type Orphan, type Registry } from "@/lib/sync/registry";
import { onLocalEdit as onStoreEdit, useData } from "@/store/data";
import { normalize } from "./migrate";
import { NEW_SCHEMA_VERSION, type NexusData } from "./types";

/** The engine's storage, plus the one verb recovery needs. */
export type SyncStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The seam onto the data store. Narrow, so a fake is four lines. */
export interface DataSeam {
  getState: () => {
    data: NexusData | null;
    adopt: (blob: NexusData) => void;
  };
}

export interface BridgeDeps {
  /**
   * Whether the local cache answered on load — `Cached.hit` from `db.ts`.
   *
   * Required, and not defaulted, because every default is wrong: `true` turns
   * an evicted phone into the tombstone catastrophe, and `false` makes a
   * healthy device withhold its edits until it has pulled. The caller has just
   * loaded and is the only thing that knows.
   */
  cacheHit: boolean;
  store?: DataSeam;
  /** Local-edit channel. Must be one an adopt cannot fire. */
  onLocalEdit?: (fn: () => void) => () => void;
  storage?: SyncStore;
  fetch?: FetchLike;
  now?: () => number;
  eventSource?: (url: string) => EventSourceLike;
  registry?: Registry;
  intervalMs?: number;
  label?: { name?: string; platform?: string };
  /** Called whenever a rehydrate drops children. Never silently swallowed. */
  onOrphans?: (orphans: Orphan[]) => void;
}

export interface BridgeStatus extends SyncStatus {
  /**
   * This device holds no record of its own and is withholding its state from
   * the diff until the server answers. A UI affordance, and the thing to look
   * at first when "my edits are not syncing".
   */
  recovering: boolean;
}

export interface NexusSync {
  /** Exposed for the sync screens (`SyncDevices`, `ConflictArchive`). */
  readonly engine: SyncEngine;
  readonly device: string;
  start: () => void;
  stop: () => void;
  sync: () => Promise<void>;
  status: () => BridgeStatus;
  subscribe: (fn: (s: BridgeStatus) => void) => () => void;
}

/**
 * The blob a recovering device offers.
 *
 * Not `{}`, and the difference is one record's worth of correctness.
 * `flatten` always mints a `__rest__` record holding everything the registry
 * does not describe — that totality is what stops an old build silently
 * deleting a field a new one added — so *something* is always offered, even
 * from an empty blob. Offering `{}` therefore publishes `__rest__ = {}`, and
 * every other device's next rehydrate rebuilds its blob from that, losing
 * `schemaVersion` until its next load re-stamps it. Harmless, self-healing,
 * and entirely avoidable: state the one fact we do know.
 */
const recoveryBlob = (): Record<string, unknown> => ({ schemaVersion: NEW_SCHEMA_VERSION });

/**
 * Discard the sync state that claims to describe this device's contents.
 *
 * Three keys out, two keys emphatically left in — see the module docstring.
 * Called once, before the engine is constructed, because the engine reads all
 * of them in its constructor and never re-reads them.
 *
 * `joined` has to go with the others. It is the "we have already decided
 * whether to seed" flag, and an evicted device that kept it would skip
 * `mayBootstrap` entirely — so a recovering device whose account turns out to
 * be genuinely empty would never seed, and would sit empty forever with a
 * clean status.
 */
export function resetOwnership(storage: SyncStore): void {
  storage.removeItem(SYNC_KEYS.cursor);
  storage.removeItem(SYNC_KEYS.baseline);
  storage.removeItem(SYNC_KEYS.joined);
}

/** localStorage, or a throwaway map when the platform refuses it. */
function defaultStorage(): SyncStore {
  try {
    if (typeof localStorage !== "undefined") {
      // Probed rather than trusted: Safari with cookies blocked exposes the
      // object and throws on use, and a throw in here is a blank app.
      localStorage.getItem(SYNC_KEYS.cursor);
      return localStorage;
    }
  } catch {
    /* fall through */
  }
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

export function createNexusSync(deps: BridgeDeps): NexusSync {
  const storage = deps.storage ?? defaultStorage();
  const store: DataSeam = deps.store ?? useData;
  const listen = deps.onLocalEdit ?? onStoreEdit;

  /**
   * True until the server has handed us data or been found empty.
   *
   * Cleared in exactly two places, both of them the engine telling us
   * something it learned from the server — never on a timer, and never because
   * the store looks populated. The store always looks populated; that is the
   * trap.
   */
  let recovering = !deps.cacheHit;
  if (recovering) resetOwnership(storage);

  /** True for the duration of a `write`. See the loop note in the docstring. */
  let applying = false;

  let orphanKeys = "";

  const engineDeps: EngineDeps = {
    read: () => {
      if (recovering) return recoveryBlob();
      // `?? recoveryBlob()` rather than `?? {}` for the reason above, and it
      // is reachable: `load()` failing outright leaves `data` null, and a diff
      // taken then must not read as "the user deleted everything" either.
      return (store.getState().data as Record<string, unknown> | null) ?? recoveryBlob();
    },

    write: (blob) => {
      applying = true;
      try {
        // Two different things, and the difference is one word in the brief:
        // the blob that *ends* recovery is a load, and every blob after it is
        // a merge.
        //
        // A merge is adopted verbatim, and must be. The engine has just
        // advanced its baseline to exactly this object, so re-shaping it makes
        // the store disagree with the baseline by whatever the re-shaping
        // touched — and the cycle after every pull then pushes that
        // difference. A pull answered with a push, on all five devices. It
        // settles once the server holds each filled-in field, so the cost is
        // bounded; two builds that disagree about what normalise produces
        // (`schemaVersion`, clamped, is one) push at each other indefinitely.
        //
        // The first one cannot be, and this is not a stylistic exception. A
        // recovering device offers no collections of its own, so the blob comes
        // back built *only* from records the server sent — and an empty
        // collection has no records to send. `dashboard.todos: []` is simply
        // absent from the pull, so `rehydrate` never creates `dashboard` at
        // all, and the screens read `data!.dashboard.todos` on a blob with no
        // `dashboard` key. A crash on the first render after an eviction, on
        // the device that just recovered.
        //
        // `normalize` is exactly the right function for that — it is what a
        // *load* does, and this is a load, from the server instead of the
        // cache. Running it once here is bounded: it can only add what the
        // server does not have, the delta is pushed once and the baseline then
        // agrees, and it is idempotent, so it cannot oscillate. Running it on
        // every adopt would be the endless churn above, which is why the flag
        // is read before it is cleared.
        const first = recovering;
        const next = first
          ? normalize(blob)
          : (blob as unknown as NexusData);
        store.getState().adopt(next);
        // The server has spoken and the store now holds what it said.
        recovering = false;
      } finally {
        applying = false;
      }
    },

    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    storage,
    now: deps.now ?? (() => Date.now()),
    // Passed explicitly even though it is the engine's default: this is the
    // one registry, it describes this exact model, and a second one would be
    // two descriptions of one mapping.
    registry: deps.registry ?? NEXUS_REGISTRY,
    ...(deps.eventSource ? { eventSource: deps.eventSource } : {}),
    ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.label ? { label: deps.label } : {}),

    onBootstrap: () => {
      // `mayBootstrap` said the server is empty, so this device is the first
      // one and the defaults it is already rendering are the seed. Releasing
      // the gate is all it takes — the next diff finds them.
      recovering = false;
      // Deferred, not immediate. `onBootstrap` runs *inside* the cycle, and
      // `sync()` hands a second caller the in-flight promise rather than
      // starting a cycle — so a nudge from here would be absorbed by the cycle
      // that triggered it and the seed would wait for the next interval. A
      // macrotask runs after the in-flight promise's `finally` has cleared,
      // which is the earliest point a fresh cycle can actually happen.
      setTimeout(() => engine.nudge(), 0);
    },
  };

  const engine = new SyncEngine(engineDeps);

  const status = (): BridgeStatus => ({ ...engine.status(), recovering });

  const stopListening = listen(() => {
    // The loop's last gate. An edit made from inside an adopt — a screen
    // reacting to new data — is not a reason to sync, and treating it as one
    // is the cycle that burns a server `seq` per lap, forever, on five
    // devices. `store/data.ts` suppresses the notification at its source; this
    // is the same window guarded from the other end, so that a future caller
    // wiring its own `onLocalEdit` cannot reintroduce it.
    if (applying) return;
    engine.nudge();
  });

  // Orphans are the known cost of per-record nesting: a task whose project was
  // deleted on another device has nowhere to land, and `rehydrate` drops it.
  // The engine already refuses to let that be silent — it collects them into
  // its status instead of the console — and relaying them is this file's share
  // of that. Reported on change rather than per cycle, because being an orphan
  // is a property of the current snapshot, not an event.
  const unwatch = engine.subscribe((s) => {
    if (!deps.onOrphans) return;
    const key = s.orphans.map((o) => `${o.collection}/${o.id}`).sort().join(",");
    if (key === orphanKeys) return;
    orphanKeys = key;
    if (s.orphans.length) deps.onOrphans(s.orphans);
  });

  return {
    engine,
    device: engine.device,
    start: () => engine.start(),
    stop: () => {
      stopListening();
      unwatch();
      engine.stop();
    },
    sync: () => engine.sync(),
    status,
    subscribe: (fn) => engine.subscribe(() => fn(status())),
  };
}

/**
 * Load the cache, then wire sync to it — the ordering the app boots in.
 *
 * One function because the two steps share a fact that must not be guessed:
 * `cacheHit`. A caller that loaded the store somewhere else and constructed
 * the bridge somewhere else has to carry that boolean between them, and the
 * value it defaults to when someone forgets is the tombstone catastrophe.
 */
export async function startNexusSync(
  opts: Omit<BridgeDeps, "cacheHit"> = {},
): Promise<NexusSync> {
  const cached = await useData.getState().load();
  const sync = createNexusSync({ ...opts, cacheHit: cached.hit });
  sync.start();
  return sync;
}
