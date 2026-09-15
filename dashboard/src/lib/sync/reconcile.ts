/**
 * Stage 3c: the reconciler — what per-record merge lets through, reported and
 * never repaired.
 *
 * 3b bought the property the plan asked for: two devices editing two different
 * records do not conflict, so neither edit is lost. The new failure arrived in
 * the same commit. A merge that never conflicts can still assemble a state
 * **neither device would ever have created alone**, because the records are
 * independent and the relationships *between* them are not.
 *
 * The case, which is not hypothetical:
 *
 * 1. The phone deletes habit `h1`. `delHabit` sweeps that habit's completions
 *    on the way out, so the phone's own state stays consistent.
 * 2. The laptop, offline, ticks `h1` for today. `toggleHabit` refuses to tick
 *    a habit it cannot see, so the laptop's state is consistent too.
 * 3. Both sync. The tombstone touches `journal.habits/h1`; the new tick
 *    touches `journal.habitCompletions/h1:2026-09-14`. Disjoint ids, nothing
 *    conflicts, both pushes are accepted, no device reports a problem.
 * 4. Every device now holds a completion whose `habitId` names nothing. The
 *    habit grid renders per habit, so the tick is invisible — and it is
 *    re-delivered and re-stored forever.
 *
 * Neither device's code can produce step 4. Only the merge can. That is the
 * whole subject of this file.
 *
 * What rehydrate already covers, and what it cannot see
 * ----------------------------------------------------
 * `rehydrate` drops a nested child whose parent is gone and reports it through
 * `onOrphan`, so `projects.tasks` with no project is already handled. That
 * mechanism is *structural*: it works only because a nested record's key
 * carries its parent's id. Between two `records` collections there is no such
 * structure — the pointer is an ordinary field inside an opaque record body,
 * and the layer below is deliberately blind to record bodies (`flatten.ts`
 * never looks inside one, which is what lets the model be ported without
 * touching sync). So nothing beneath this file will ever notice a dangling
 * `habitId`, however many devices are involved.
 *
 * This file is therefore the one place in sync that reads inside a record —
 * and it does so through a declarative table rather than by naming habits, on
 * the same bargain as `NEXUS_REGISTRY`: one line per reference, no logic.
 *
 * > **Never auto-repair. Surface a needs-attention list.**
 *
 * Silently rewriting the user's data is worse than a visible break. A repair
 * that guesses wrong is indistinguishable from the app losing data on its own,
 * and — unlike a purely local bug — it does not stay local: it propagates to
 * every other device as an authoritative write. Deleting the dangling
 * completion is the tempting one-liner and it is the worst option on the
 * table. It is a *second* edit layered on a deletion, so it republishes the
 * phone's delete as a fresh write, and it destroys the only remaining evidence
 * that the tick ever happened.
 *
 * `reconcile` is consequently a pure function of a snapshot. It does not
 * mutate, it does not push, and it returns findings carrying a sentence a
 * person can act on plus the remedy as *data* for a UI to offer. Choosing
 * between remedies costs someone data either way, which is what makes it the
 * user's choice and not this file's.
 */
import {
  NEXUS_REGISTRY,
  rehydrate,
  splitKey,
  type Orphan,
  type Registry,
} from "./registry";
import type { Snapshot } from "./flatten";

/**
 * One cross-collection reference: who holds the pointer, and what it points at.
 *
 * `to` must name a `records` collection. A `singleton` bucket is keyed by the
 * collection name and a `nested` bucket by `parentId:childId`, so a reference
 * compared against either would match nothing and *every* holding record would
 * be reported. A needs-attention list that cries wolf is a list nobody reads,
 * which is a worse outcome than having no check — so the self-check test
 * enforces this rather than leaving it to whoever adds the next line.
 *
 * `holder` and `target` are the nouns the message is built from. They live in
 * the table because the alternative is a `switch` on collection name inside
 * the reporting code, which is the hardcoding this whole shape exists to avoid.
 */
export interface ReferenceSpec {
  /** Collection holding the pointer. A registry collection name. */
  from: string;
  /** The field on the holding record that carries the target's id. */
  field: string;
  /** Collection the id points into. Must be `kind: "records"`. */
  to: string;
  /** Human noun for the holding record, e.g. "habit tick". */
  holder: string;
  /** Human noun for the target record, e.g. "habit". */
  target: string;
}

export type References = readonly ReferenceSpec[];

/**
 * The NexusData reference table.
 *
 * Found by reading `types.ts` for a field on one record type that holds
 * another record type's id. Two qualify, and the second is here to prove the
 * first is not special-cased.
 *
 * What was considered and deliberately left out, because a "reference" that is
 * really a label would report healthy data as broken:
 *
 * - `Course.semester` is a `string` naming a semester, and `academics.semesters`
 *   is a `singleton` holding a bare `string[]`. No ids exist on either side, so
 *   there is nothing to dangle — and a course whose semester was renamed is a
 *   display question, not a merge casualty.
 * - `StudyPlan.course` is free text that happens to read like a course code
 *   ("CS5800"); the plan form types it by hand and never offers course ids.
 * - `Fragment.category` points into `JOURNAL_CATEGORIES`, a compile-time
 *   constant. It cannot be deleted on another device, so it cannot dangle from
 *   a merge; a bad value there is a migration concern.
 * - `Attachment.stored_name` names a file on the server, not a record. Out of
 *   this layer's reach entirely.
 *
 * `HabitCompletion.id` is `${habitId}:${date}`, so the habit id is also
 * embedded in the record's own key — and reading the pointer from the key
 * instead of the field is a deliberate non-choice. The id is a *primary* key
 * whose job is convergence (two devices ticking the same habit on the same day
 * mint the same id); treating it as a declared foreign key would make the
 * check unfalsifiable by the record's own contents and would report records the
 * table never claimed to cover.
 */
export const NEXUS_REFERENCES: References = [
  { from: "journal.habitCompletions", field: "habitId", to: "journal.habits", holder: "habit tick", target: "habit" },
  { from: "academics.studyPlanner.sessions", field: "plan", to: "academics.studyPlanner.plans", holder: "study session", target: "study plan" },
];

/**
 * What kind of break this is.
 *
 * Kept as two values rather than one "broken record" bucket because the two
 * have different evidence behind them: an orphan was *observed* being dropped
 * by `rehydrate`, while a dangling reference is inferred from a field this file
 * chose to read. A UI that wants to phrase them differently, or trust them
 * differently, can.
 */
export type FindingKind = "dangling-reference" | "orphaned-child";

/**
 * A repair, as data. Nothing here performs one.
 *
 * Both are offered for every finding, and the plurality is the point: for a
 * tick whose habit is gone, deleting the tick loses the fact that the day was
 * ticked, and recreating the habit resurrects something someone deliberately
 * deleted. There is no repair that costs nothing, so there is no repair this
 * file is entitled to pick.
 */
export type Remedy =
  | { action: "delete-record"; collection: string; id: string }
  | { action: "recreate-record"; collection: string; id: string };

/** One thing that needs a human. Enough to render an actionable sentence. */
export interface Finding {
  kind: FindingKind;
  /** The record that needs attention. `id` is its snapshot key. */
  collection: string;
  id: string;
  /**
   * The field carrying the broken pointer.
   *
   * Absent for an orphan, and not an oversight: a nested record's pointer is
   * its own key, so there is no field to name. A UI showing "field" for an
   * orphan would be inventing one.
   */
  field?: string;
  /** What it points at, and the collection that should have held it. */
  missing: { collection: string; id: string };
  /** One line, already phrased for a person. */
  message: string;
  remedies: readonly Remedy[];
}

/**
 * Whether a target record is really there.
 *
 * Not `Object.hasOwn`. A tombstone normally removes the key outright
 * (`applyPulled` deletes it, and drops the bucket when it empties), but the
 * same function writes `bucket[id] = r.body` for a live record whose `body` is
 * absent — so a present key with no body is reachable from the wire. A
 * key-existence check would call that habit present, and the report would come
 * back clean while the app has nothing to render. Absent, tombstoned and
 * bodyless collapse into one honest answer: gone.
 */
const present = (bucket: Record<string, unknown> | undefined, id: string): boolean => {
  const body = bucket?.[id];
  return body !== null && body !== undefined;
};

/**
 * The id a record points at, or `undefined` for "points nowhere".
 *
 * An absent field, `null`, and `""` are all *not* dangling references —
 * nothing is pointing anywhere, so nothing is broken. `StudySession.plan` is
 * `ID | null` and the plan `<select>`'s "No plan" option has `value=""`, which
 * the screens normalise to `null` on the way in; conflating either with a
 * missing plan would report every unplanned session in the app, forever, on
 * first load.
 *
 * A non-string pointer is skipped for a different reason: it is a malformed
 * record, which `migrate.ts` owns. Filing it here would put a line in the
 * needs-attention list that no user action can clear.
 */
function pointerOf(record: unknown, field: string): string | undefined {
  if (record === null || typeof record !== "object") return undefined;
  const raw = (record as Record<string, unknown>)[field];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** `projects[].tasks` → the registry name of the collection at `projects`. */
function parentCollectionOf(registry: Registry, path: string): string {
  const at = path.indexOf("[]");
  if (at < 0) return path;
  const parentPath = path.slice(0, at);
  // Falling back to the raw path keeps the message truthful when a nested
  // collection's parent is unregistered — a registry bug, but one that must
  // not render as `undefined` in a sentence shown to someone.
  return registry.find((s) => s.path === parentPath)?.name ?? parentPath;
}

/**
 * Canonical finding order, for the same reason `rehydrate` sorts records.
 *
 * `Object.entries` on a bucket yields insertion order, which is the order the
 * server's `seq` happened to deliver records in — so two devices holding
 * identical data would show the user the same findings in different orders,
 * and a list that reshuffles between loads reads as churn rather than as a
 * problem someone should act on.
 */
const byFinding = (a: Finding, b: Finding): number =>
  a.kind !== b.kind
    ? a.kind < b.kind
      ? -1
      : 1
    : a.collection !== b.collection
      ? a.collection < b.collection
        ? -1
        : 1
      : a.id !== b.id
        ? a.id < b.id
          ? -1
          : 1
        : (a.field ?? "") < (b.field ?? "")
          ? -1
          : (a.field ?? "") > (b.field ?? "")
            ? 1
            : 0;

/**
 * Everything in `snapshot` that needs a human, in canonical order.
 *
 * Pure. It clones nothing of its own because it needs nothing of its own:
 * `rehydrate` already clones before it writes, and the reference sweep only
 * reads. The caller holds this snapshot as its sync baseline, and moving a
 * baseline makes the next diff come out empty — two devices agreeing to
 * disagree, permanently and silently.
 */
export function reconcile(
  snapshot: Snapshot,
  registry: Registry = NEXUS_REGISTRY,
  references: References = NEXUS_REFERENCES,
): Finding[] {
  const findings: Finding[] = [];

  // ── orphaned children ──────────────────────────────────────────────────
  //
  // Delegated to `rehydrate` rather than reimplemented from the snapshot, and
  // that is the load-bearing choice here: `rehydrate` is the code that
  // actually does the dropping. A second implementation of "is this parent
  // present" could disagree with it, and a needs-attention list that disagrees
  // with the app's real behaviour is worse than no list — it would either hide
  // a dropped record or accuse a healthy one. The rebuilt blob is discarded;
  // only the report is wanted.
  const orphans: Orphan[] = [];
  rehydrate(snapshot, registry, (o) => orphans.push(o));

  const parentOf = new Map<string, string>();
  for (const spec of registry) {
    if (spec.kind === "nested") parentOf.set(spec.name, parentCollectionOf(registry, spec.path));
  }

  for (const o of orphans) {
    // `splitKey`, never a bare split on ":". Ids here carry colons on both
    // sides — the roadmap seed mints `seed:0001:phase:…` parents and a habit
    // completion's id is `${habitId}:${date}` — so a hand-rolled split would
    // name a parent of "seed", and the remedy below would offer to recreate a
    // record that has never existed.
    const { parent, child } = splitKey(o.id);
    const parentCollection = parentOf.get(o.collection) ?? "";
    findings.push({
      kind: "orphaned-child",
      collection: o.collection,
      id: o.id,
      missing: { collection: parentCollection, id: parent },
      message:
        `${child} in ${o.collection} belongs to ${parentCollection} ${parent}, which is not in ` +
        `your data — it is dropped every time the app loads, so nothing can show it.`,
      // Deleting is a real remedy despite the record already being invisible:
      // it lives on in the server's log and is re-pulled on every sync, so
      // without either a tombstone or its parent back, this finding returns
      // forever.
      remedies: [
        { action: "delete-record", collection: o.collection, id: o.id },
        { action: "recreate-record", collection: parentCollection, id: parent },
      ],
    });
  }

  // ── dangling references between `records` collections ──────────────────
  for (const ref of references) {
    const holders = snapshot[ref.from];
    if (!holders) continue;
    // Bound to a local: under `noUncheckedIndexedAccess` an index access is
    // `T | undefined` and does not stay narrowed across statements. An absent
    // target bucket is not skipped the way an absent holder bucket is — every
    // pointer into a collection that is entirely gone dangles, which is
    // exactly what deleting the last habit on another device looks like.
    const targets = snapshot[ref.to];
    for (const [id, record] of Object.entries(holders)) {
      const pointer = pointerOf(record, ref.field);
      if (pointer === undefined) continue;
      if (present(targets, pointer)) continue;
      findings.push({
        kind: "dangling-reference",
        collection: ref.from,
        id,
        field: ref.field,
        missing: { collection: ref.to, id: pointer },
        message:
          `A ${ref.holder} refers to a ${ref.target} that is not in your data (${pointer}) — ` +
          `most likely the ${ref.target} was deleted on another device while this was written.`,
        remedies: [
          { action: "delete-record", collection: ref.from, id },
          { action: "recreate-record", collection: ref.to, id: pointer },
        ],
      });
    }
  }

  return findings.sort(byFinding);
}
