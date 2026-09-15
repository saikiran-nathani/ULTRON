/**
 * The capture inbox — and the argument for why it is not a new collection.
 *
 * The plan's gate for this surface is a week of capturing from a phone with
 * **nothing lost and nothing typed twice**, so every decision below is made
 * against those two words rather than against tidiness.
 *
 * Why the inbox IS `journal.fragments`
 * ------------------------------------
 * A `Fragment` already carries everything a captured thought needs — the one
 * line (`fragment`), an optional why (`body`), a `FragmentType` that is
 * exactly the seed/thread/principle/action vocabulary triage wants, a local
 * `date`, and `createdAt`/`updatedAt`. What it lacks is a notion of *untriaged*,
 * and `category` supplies it: every fragment written by the journal UI carries
 * one of `JOURNAL_CATEGORIES`' ids, so a reserved id that appears in no
 * category list is, by construction, "not filed yet".
 *
 * Three consequences, in order of how much they matter:
 *
 * 1. **`journal.fragments` is already in `NEXUS_REGISTRY` as a `records`
 *    collection.** A new collection cannot be registered without editing
 *    `src/lib/sync/registry.ts`, and an *unregistered* collection falls into
 *    the `__rest__` singleton — which means the whole inbox is one opaque
 *    record under last-writer-wins. Capture on the phone offline, capture on
 *    the laptop in the same window, and one blob overwrites the other: the
 *    exact "nothing lost" failure, in the one place the plan says must never
 *    have it. Reusing fragments gets per-record sync on day one.
 * 2. **Triage becomes a one-field write to one record.** "Keep" sets
 *    `category`; nothing is created, nothing is deleted, and two devices
 *    triaging two different captures do not conflict at all. A separate inbox
 *    collection would make every keep a delete-plus-create across two
 *    collections — two records to lose instead of one field to merge.
 * 3. **Nothing is typed twice.** A capture that is going to live as a thought
 *    never moves: the record the user typed into is the record that survives.
 *    Only filing into another domain (a todo, a task, a reading item) copies
 *    the text, and that copy is done by `file()` in a single recipe — never by
 *    the user.
 *
 * The cost, stated plainly: an untriaged capture is a `Fragment` with a
 * category no journal view knows, so it renders nowhere except here until it
 * is triaged. That is the intended behaviour — an inbox item should be visible
 * in exactly one place, the inbox — but it does mean a journal screen that
 * groups by `JOURNAL_CATEGORIES` will not show it, and should not try to.
 *
 * What happens to a capture typed offline
 * ---------------------------------------
 * `add()` calls `update()` and then `flush()`, in that order, deliberately.
 * `update` alone arms a 250ms debounce (`SAVE_DEBOUNCE_MS`), which is right
 * for keystrokes and wrong for a commit: a phone killed inside that window
 * loses a capture that the UI has already cleared from the box. `flush()`
 * cancels the debounce, writes localStorage synchronously, and announces the
 * edit so the sync bridge asks for a cycle immediately. Offline, that cycle
 * fails; the engine keeps its baseline, so the record is still in the next
 * diff and goes up whenever the network returns.
 *
 * The one loss that remains is a platform limit rather than a bug, and it is
 * worth naming: localStorage is a *cache*, the server is the record (see
 * `db.ts`). A capture that never reached the server before iOS evicted the
 * PWA's storage — ~7 days unopened — is gone, because localStorage held the
 * only copy. The recovery path is still safe (a cache miss makes the bridge
 * discard cursor/baseline/joined and pull rather than push tombstones, so the
 * other devices keep their data), but that capture is not recoverable. Everything
 * here is aimed at shrinking that window to a single request: commit persists
 * now, not in 250ms, and nudges sync now, not at the next interval.
 *
 * The draft
 * ---------
 * Text that has been typed but not committed is not a capture, and must not be
 * synced — a half-finished thought pushed to five devices is noise, and on
 * every keystroke it is a request per character. But it must survive the app
 * being killed mid-typing, which is the single most likely way a phone loses
 * one. So the draft lives in its own localStorage key, outside `NexusData` and
 * outside sync: device-local, restored on mount, cleared only once the commit
 * has landed in the blob.
 */
import { useData } from "./data";
import { SORT_STEP } from "@/lib/nexus/constants";
import { daysFromToday, todayStr, uid } from "@/lib/nexus/format";
import type { Fragment, FragmentType, NexusData } from "@/lib/nexus/types";

/**
 * The reserved `category` that means "captured, not yet triaged".
 *
 * Exported rather than inlined so a journal screen can exclude it explicitly
 * instead of discovering it as an unknown id. It deliberately matches no entry
 * in `JOURNAL_CATEGORIES`, and must keep matching none.
 */
export const INBOX_CATEGORY = "inbox";

/** localStorage key for the uncommitted compose text. Never synced. */
export const CAPTURE_DRAFT_KEY = "nexus-capture-draft-v1";

/** The slice of `Storage` the draft needs. Injected so tests are three lines. */
export type DraftStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Typed shorthands, and the reason they are rules rather than guesses.
 *
 * Classifying a capture by inspecting its prose would be a heuristic that is
 * wrong often enough to need checking, which is a decision at capture time —
 * the thing "one box, one tap" exists to remove. These two are markers the
 * user chose to type, so they are unambiguous, and everything else defaults to
 * `seed` and is one tap to change during triage.
 */
const ACTION_PREFIX = /^(?:!|todo:)\s*/i;

export interface ParsedCapture {
  fragment: string;
  body?: string;
  type: FragmentType;
}

/**
 * Raw box text → the record's fields, or `null` when there is nothing to keep.
 *
 * The first non-empty line is the thought and the rest is the why, which is
 * the shape `Fragment` already has (`fragment` is documented as one line,
 * `body` as "why it matters"). Splitting a multi-line paste into several
 * captures was the alternative and is worse: it shreds a thought that happened
 * to be typed across two lines, and there is no way to undo that except by
 * retyping it — which is the failure this screen is measured on.
 */
export function parseCapture(raw: string): ParsedCapture | null {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let head = "";
  let at = 0;
  while (at < lines.length) {
    // `noUncheckedIndexedAccess`: an index into a split is `string | undefined`
    // and does not stay narrowed across statements.
    const line = (lines[at] ?? "").trim();
    at += 1;
    if (line) {
      head = line;
      break;
    }
  }
  if (!head) return null;

  const body = lines.slice(at).join("\n").trim();

  let type: FragmentType = "seed";
  const stripped = head.replace(ACTION_PREFIX, "").trim();
  if (stripped !== head) {
    type = "action";
    head = stripped;
  } else if (head.endsWith("?")) {
    // `thread` is defined in the model as "open question I'm living with", so a
    // question mark is the marker rather than an inference about the content.
    type = "thread";
  }
  if (!head) return null;

  return { fragment: head, type, ...(body ? { body } : {}) };
}

/** Whether a captured line is a bare URL, so filing it can fill `url`. */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * The inbox, newest first — ordered by a field, never by array position.
 *
 * Per-record sync rebuilds arrays in key order, not arrival order, so a screen
 * that trusted position would render a different list on each device with the
 * data fully converged (see the note on `byKey` in `lib/sync/registry.ts`).
 * `createdAt` is the order the user made them in; `id` breaks ties, because two
 * captures inside the same millisecond are possible and a non-deterministic
 * tiebreak is the same bug at a smaller scale.
 */
export function orderInbox<T extends { id: string; createdAt: string }>(list: T[]): T[] {
  return [...list].sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/** Untriaged captures, newest first. */
export function inboxOf(fragments: Fragment[]): Fragment[] {
  return orderInbox(fragments.filter((f) => f.category === INBOX_CATEGORY));
}

/** "today" / "yesterday" / "4d ago" from a fragment's local day. */
export function ageLabel(date: string): string {
  const diff = daysFromToday(date);
  if (diff >= 0) return "today";
  if (diff === -1) return "yesterday";
  return `${-diff}d ago`;
}

/* ── filing ─────────────────────────────────────────────────────────────── */

/**
 * Where a capture can be filed.
 *
 * Every one of these is a collection that already exists in the model, which
 * is the brief's constraint and also the point: filing must not mint a new
 * kind of thing, or the inbox becomes a fourth place to look.
 */
export type FileTarget =
  | { kind: "todo" }
  | { kind: "reading" }
  | { kind: "task"; projectId: string };

export interface FileTargetOption {
  /** Stable string for a `<select>`; decode with `parseFileTarget`. */
  value: string;
  label: string;
  target: FileTarget;
}

export const encodeFileTarget = (t: FileTarget): string =>
  t.kind === "task" ? `task:${t.projectId}` : t.kind;

export function parseFileTarget(value: string): FileTarget | null {
  if (value === "todo" || value === "reading") return { kind: value };
  if (value.startsWith("task:")) {
    const projectId = value.slice("task:".length);
    return projectId ? { kind: "task", projectId } : null;
  }
  return null;
}

/**
 * The filing menu, built from what exists rather than from a fixed list.
 *
 * Projects are ordered by name (then id), not by their position in
 * `data.projects` — same reason as `orderInbox`. A project deleted on another
 * device simply stops being offered; a capture already aimed at it is handled
 * by `file()`, which refuses rather than dropping the fragment.
 */
export function fileTargets(data: NexusData): FileTargetOption[] {
  const projects = [...data.projects].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return [
    { value: "todo", label: "Todo", target: { kind: "todo" } },
    { value: "reading", label: "Reading list", target: { kind: "reading" } },
    ...projects.map((p) => ({
      value: encodeFileTarget({ kind: "task", projectId: p.id }),
      label: `Task — ${p.name || "Untitled project"}`,
      target: { kind: "task", projectId: p.id } as FileTarget,
    })),
  ];
}

/**
 * Create the filed record. Returns false when the target is gone.
 *
 * The return value is the whole of the "nothing lost" guarantee for filing: the
 * caller only removes the fragment when this says the text landed somewhere,
 * so a capture aimed at a project that another device deleted stays in the
 * inbox instead of evaporating.
 */
function createFiled(d: NexusData, f: Fragment, target: FileTarget): boolean {
  const text = f.fragment;
  const body = f.body ?? "";

  if (target.kind === "todo") {
    // `order` is derived from the maximum, not from `todos.length`: length is
    // array position wearing a different name, and two devices adding a todo
    // offline would both claim the same slot.
    const order = d.dashboard.todos.reduce((m, t) => Math.max(m, t.order ?? 0), 0) + 1;
    d.dashboard.todos.push({
      id: uid(),
      text,
      done: false,
      // Not `todayStr()`. Filing says where a thought belongs, not when it is
      // due, and inventing a deadline the user never typed is inventing data.
      // The home widget shows undated todos, so it still surfaces today.
      dueDate: null,
      order,
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  if (target.kind === "reading") {
    d.journal.readingList.push({
      id: uid(),
      title: text,
      author: "",
      type: "Article",
      status: "Queue",
      url: looksLikeUrl(text) ? text : "",
      notes: body,
    });
    return true;
  }

  const project = d.projects.find((p) => p.id === target.projectId);
  if (!project) return false;
  const maxSort = project.tasks.reduce((m, t) => Math.max(m, t.sort ?? 0), 0);
  project.tasks.push({
    id: uid(),
    name: text,
    priority: "Medium",
    done: false,
    doneAt: null,
    notes: body,
    attachments: [],
    sort: maxSort + SORT_STEP,
  });
  return true;
}

/* ── actions ────────────────────────────────────────────────────────────── */

const touch = (f: Fragment) => void (f.updatedAt = new Date().toISOString());

export const capture = {
  /**
   * Commit one capture. Returns whether it landed, so the box only clears when
   * it did.
   *
   * The `data == null` guard is not defensive noise: `update()` silently skips
   * its recipe when the blob has not loaded (`if (s.data) recipe(...)`), so
   * without this the box would clear and the capture would go nowhere — a
   * capture lost with a success animation over it.
   */
  add(raw: string): boolean {
    const parsed = parseCapture(raw);
    if (!parsed) return false;
    const { data, update, flush } = useData.getState();
    if (!data) return false;

    const now = new Date().toISOString();
    update((d) => {
      // `push`, not `unshift`. `journal.addFragment` unshifts because the
      // journal screen read position; nothing here does, and flatten/rehydrate
      // would not preserve it anyway.
      d.journal.fragments.push({
        id: uid(),
        date: todayStr(),
        category: INBOX_CATEGORY,
        fragment: parsed.fragment,
        ...(parsed.body ? { body: parsed.body } : {}),
        type: parsed.type,
        recurrence: 1,
        promoted: false,
        createdAt: now,
        updatedAt: now,
      });
    });
    // See the module docstring: a commit persists now, not in 250ms.
    flush();
    return true;
  },

  /** Retype a capture during triage. One field, one record. */
  setType(id: string, type: FragmentType): void {
    const { data, update, flush } = useData.getState();
    if (!data) return;
    update((d) => {
      const f = d.journal.fragments.find((x) => x.id === id);
      if (!f || f.category !== INBOX_CATEGORY) return;
      f.type = type;
      touch(f);
    });
    flush();
  },

  /**
   * Keep it as a thought: give it a real category and it leaves the inbox.
   *
   * Nothing is created and nothing is deleted — the record the user typed into
   * is the record that survives, which is what makes this the cheapest and
   * safest of the three triage verbs.
   */
  keep(id: string, category: string): boolean {
    if (!category || category === INBOX_CATEGORY) return false;
    const { data, update, flush } = useData.getState();
    if (!data) return false;
    let ok = false;
    update((d) => {
      const f = d.journal.fragments.find((x) => x.id === id);
      if (!f || f.category !== INBOX_CATEGORY) return;
      f.category = category;
      // `The Room` is the model's "worth keeping forever" shelf, and its own
      // category id. Keeping into it is the one case that also sets the flag,
      // so the two cannot disagree.
      if (category === "room") f.promoted = true;
      touch(f);
      ok = true;
    });
    if (ok) flush();
    return ok;
  },

  /**
   * File it into another domain: create the target, then drop the fragment.
   *
   * Both halves are one `update` recipe, so they are one immer produce, one
   * localStorage write and one sync diff. There is no instant at which the text
   * exists in neither place, and no instant at which it exists in both.
   */
  file(id: string, target: FileTarget): boolean {
    const { data, update, flush } = useData.getState();
    if (!data) return false;
    let ok = false;
    update((d) => {
      const at = d.journal.fragments.findIndex((x) => x.id === id);
      if (at < 0) return;
      const f = d.journal.fragments[at];
      if (!f || f.category !== INBOX_CATEGORY) return;
      if (!createFiled(d, f, target)) return;
      d.journal.fragments.splice(at, 1);
      ok = true;
    });
    if (ok) flush();
    return ok;
  },

  /** Drop it. Confirmed in the UI, because a mis-tap here is a loss. */
  drop(id: string): boolean {
    const { data, update, flush } = useData.getState();
    if (!data) return false;
    let ok = false;
    update((d) => {
      const before = d.journal.fragments.length;
      d.journal.fragments = d.journal.fragments.filter(
        (f) => !(f.id === id && f.category === INBOX_CATEGORY),
      );
      ok = d.journal.fragments.length < before;
    });
    if (ok) flush();
    return ok;
  },
};

/* ── the draft ──────────────────────────────────────────────────────────── */

/** localStorage, or nothing when the platform refuses it (private Safari). */
function draftStore(): DraftStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readDraft(store: DraftStore | null = draftStore()): string {
  if (!store) return "";
  try {
    return store.getItem(CAPTURE_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Persist the uncommitted box text. Returns whether it landed.
 *
 * A `false` here is the honest version of "this might be lost if you close the
 * tab", and the screen says so rather than swallowing it — a full quota or a
 * blocked store is exactly the condition under which a capture disappears with
 * no symptom.
 */
export function writeDraft(text: string, store: DraftStore | null = draftStore()): boolean {
  if (!store) return false;
  try {
    if (text) store.setItem(CAPTURE_DRAFT_KEY, text);
    else store.removeItem(CAPTURE_DRAFT_KEY);
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(store: DraftStore | null = draftStore()): void {
  if (!store) return;
  try {
    store.removeItem(CAPTURE_DRAFT_KEY);
  } catch {
    /* nothing to do — the draft is already unreachable */
  }
}

/* ── reading the store ──────────────────────────────────────────────────── */

/**
 * The blob, nullably, plus the two facts a screen needs to tell loading from
 * failure from empty.
 *
 * Every other slice exposes `useData((s) => s.data!.x)`, which crashes on a
 * blob that has not loaded. Both of this brief's screens are reachable at boot
 * — `home` is the default screen — so they read the nullable value and render
 * three visibly different states instead.
 *
 * Four separate selectors rather than one returning an object: zustand compares
 * snapshots with `Object.is`, and a selector that builds a fresh object every
 * call re-renders forever.
 */
export function useBlob() {
  const data = useData((s) => s.data);
  const loaded = useData((s) => s.loaded);
  const error = useData((s) => s.error);
  const saveStatus = useData((s) => s.saveStatus);
  return { data, loaded, error, saveStatus };
}
