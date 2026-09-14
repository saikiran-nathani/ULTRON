/**
 * The client half of sync, and the one rule that lives entirely here.
 *
 * > **Diff against your own previous state, never against the server's.**
 *
 * Comparing local to remote cannot distinguish *deleted* from *never-seen*:
 * both look like "they have a record I do not". So a client that diffs against
 * the server re-pulls every record it has ever deleted, forever, and every
 * deletion resurrects on the next sync. Silently, and with no way for the user
 * to make it stop.
 *
 * The fix is a **baseline**: a snapshot of what this device last successfully
 * pushed. The diff is `current` vs `baseline`, so an absence in `current` that
 * was present in `baseline` is unambiguously a deletion, and an absence in
 * both is simply not our business.
 *
 * Model-agnostic on purpose
 * -------------------------
 * This operates on `Snapshot` — `collection -> id -> record` — and never looks
 * inside a record. That mirrors the server, which stores opaque JSON, and it
 * means the app's data model can be ported (Stage 4) without touching a line
 * of sync code. A sync layer that knows the shape of a `Project` is a sync
 * layer that has to be rewritten whenever a `Project` changes.
 */

/** Anything with a stable identity. The engine never inspects the value. */
export type Record_ = unknown;

/** `collection -> id -> record`. The wire shape and the diff shape. */
export type Snapshot = Record<string, Record<string, Record_>>;

/** One record version, as the server's `/api/sync` accepts it. */
export interface Change {
  collection: string;
  id: string;
  hlc: string;
  deleted?: boolean;
  body?: Record_;
}

export interface Diff {
  changes: Change[];
  /** Counts, for a "3 pending" indicator and for tests. */
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Structural equality over JSON-ish values.
 *
 * `JSON.stringify` comparison is the tempting one-liner and it is wrong: key
 * order is insertion order, so `{a:1,b:2}` and `{b:2,a:1}` stringify
 * differently while being the same record. That would mark every record dirty
 * after any round-trip that reordered keys — which an object rebuilt from a
 * server response routinely does — and push the entire dataset on every sync.
 */
export function sameRecord(a: Record_, b: Record_): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== "object" || typeof b !== "object") return a === b;

  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const x = a as Record_[];
    const y = b as Record_[];
    // Arrays ARE order-sensitive — a list of tasks is not a set — so this is
    // deliberately not the same treatment as object keys.
    return x.length === y.length && x.every((v, i) => sameRecord(v, y[i]));
  }

  const x = a as Record<string, Record_>;
  const y = b as Record<string, Record_>;
  const xk = Object.keys(x);
  const yk = Object.keys(y);
  if (xk.length !== yk.length) return false;
  return xk.every((k) => Object.hasOwn(y, k) && sameRecord(x[k], y[k]));
}

/**
 * What changed since `baseline`, as changes the server can apply.
 *
 * `nextHlc` is called once per change rather than once per diff, so every
 * change in a batch gets a distinct, increasing clock reading. Sharing one
 * reading across a batch would make two edits to the same record in one
 * offline window indistinguishable, and the server would have to pick
 * arbitrarily between them.
 */
export function diff(
  baseline: Snapshot,
  current: Snapshot,
  nextHlc: () => string,
): Diff {
  const changes: Change[] = [];
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const [collection, records] of Object.entries(current)) {
    const before = baseline[collection] ?? {};
    for (const [id, body] of Object.entries(records)) {
      if (!Object.hasOwn(before, id)) {
        changes.push({ collection, id, hlc: nextHlc(), body });
        created += 1;
      } else if (!sameRecord(before[id], body)) {
        changes.push({ collection, id, hlc: nextHlc(), body });
        updated += 1;
      }
      // Unchanged records are not sent. At 38 KB we could send everything and
      // it would still be fast — but every needless push burns a server `seq`
      // and re-delivers the record to every other device, so a no-op sync
      // would generate traffic on all five.
    }
  }

  // Deletions: present in the baseline, absent now. THIS is the half that a
  // local-vs-remote diff cannot express at all.
  for (const [collection, records] of Object.entries(baseline)) {
    const now = current[collection] ?? {};
    for (const id of Object.keys(records)) {
      if (!Object.hasOwn(now, id)) {
        changes.push({ collection, id, hlc: nextHlc(), deleted: true });
        deleted += 1;
      }
    }
  }

  return { changes, created, updated, deleted };
}

/**
 * Fold the server's records into a snapshot, honouring tombstones.
 *
 * Applied to BOTH the live state and the baseline, because after a pull the
 * server's version is what this device last agreed with. Advancing one without
 * the other would make the next diff re-push whatever the pull just changed —
 * an infinite exchange between two devices that already agree.
 */
export function applyPulled(
  snapshot: Snapshot,
  records: { collection: string; id: string; deleted?: boolean; body?: Record_ }[],
): Snapshot {
  // A new object rather than a mutation: the caller holds the previous
  // snapshot as its baseline, and mutating it in place would silently move the
  // thing the next diff is measured against.
  const next: Snapshot = {};
  for (const [c, recs] of Object.entries(snapshot)) next[c] = { ...recs };

  for (const r of records) {
    if (r.deleted) {
      // A tombstone is a record to apply, not an absence to ignore. A client
      // that skipped these could never learn that anything was removed.
      // Bound to a local: under `noUncheckedIndexedAccess` an index access is
      // `T | undefined` and does not stay narrowed across statements.
      const bucket = next[r.collection];
      if (bucket) {
        delete bucket[r.id];
        if (Object.keys(bucket).length === 0) delete next[r.collection];
      }
      continue;
    }
    (next[r.collection] ??= {})[r.id] = r.body;
  }
  return next;
}

/** A deep-enough copy to serve as an immutable baseline. */
export function snapshotOf(s: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(s)) as Snapshot;
}

/**
 * Whether this device may seed default data.
 *
 * > **A device whose first pull returns anything never bootstraps.**
 *
 * The plan asks for this even though the collision it guards against was
 * removed with `work` and `finance`, because it costs three lines and protects
 * any future seeded record. It is also no longer hypothetical: the roadmap
 * seed mints dozens of records, and while their ids are now content-derived,
 * a device that seeds them *and* pulls them would still write them twice under
 * two different clocks.
 *
 * The test is "has the server anything at all", not "has it my collections" —
 * a second device joining an established account must adopt, never seed.
 */
export function mayBootstrap(head: number, pulled: number): boolean {
  return head === 0 && pulled === 0;
}
