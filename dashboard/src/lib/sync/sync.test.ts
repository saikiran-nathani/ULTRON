/**
 * The client half's correctness argument.
 *
 * Rule 1 — *diff against your own previous state, never the server's* — lives
 * entirely on this side, so until these existed it was the one rule with no
 * test anywhere. The server cannot check it: from the server's view a client
 * that re-pushes a deleted record and one that legitimately re-creates it are
 * the same request.
 */
import { describe, expect, it, vi } from "vitest";
import { Clock, ClockError, MAX_DRIFT_MS, deviceId, formatHlc, parseHlc } from "./clock";
import { applyPulled, diff, mayBootstrap, sameRecord, snapshotOf, type Snapshot } from "./flatten";

const T0 = 1_789_344_000_000;

/** A deterministic clock, so a failure is reproducible. */
function counter(node = "dev-a") {
  let n = 0;
  return () => formatHlc(T0, n++, node);
}

// ══ rule 1: the diff base ════════════════════════════════════════════════

describe("diffing against our own baseline", () => {
  it("reports a created record", () => {
    const out = diff({}, { journal: { a: { v: 1 } } }, counter());
    expect(out.created).toBe(1);
    expect(out.changes).toEqual([
      { collection: "journal", id: "a", hlc: formatHlc(T0, 0, "dev-a"), body: { v: 1 } },
    ]);
  });

  it("reports an updated record and skips unchanged ones", () => {
    const base: Snapshot = { journal: { a: { v: 1 }, b: { v: 2 } } };
    const out = diff(base, { journal: { a: { v: 99 }, b: { v: 2 } } }, counter());
    expect([out.created, out.updated, out.deleted]).toEqual([0, 1, 0]);
    expect(out.changes.map((c) => c.id)).toEqual(["a"]);
  });

  it("expresses a deletion as a tombstone", () => {
    // THE RULE. Present in the baseline, absent now — which is a fact a
    // local-vs-remote comparison cannot represent at all.
    const out = diff({ journal: { a: { v: 1 } } }, {}, counter());
    expect(out.deleted).toBe(1);
    expect(out.changes[0]).toMatchObject({ collection: "journal", id: "a", deleted: true });
    expect(out.changes[0]!.body).toBeUndefined();
  });

  it("does not resurrect a record deleted locally", () => {
    // The failure this rule prevents, end to end.
    //
    // A client diffing against the SERVER sees "the server has `a`, I do not"
    // and pulls it back — every sync, forever, with the user deleting it again
    // each time. Diffing against our own baseline says "I had `a`, I removed
    // it", which is a push, not a pull.
    let baseline: Snapshot = { journal: { a: { v: 1 } } };
    let current: Snapshot = {}; // user deleted it

    const first = diff(baseline, current, counter());
    expect(first.changes[0]).toMatchObject({ id: "a", deleted: true });

    // The server accepted it, so the baseline advances to what we pushed.
    baseline = snapshotOf(current);

    // Next sync: nothing to say. Under a local-vs-remote diff this is where
    // the record would come back.
    expect(diff(baseline, current, counter()).changes).toEqual([]);

    // And a pull that (correctly) carries the tombstone changes nothing.
    current = applyPulled(current, [{ collection: "journal", id: "a", deleted: true }]);
    baseline = applyPulled(baseline, [{ collection: "journal", id: "a", deleted: true }]);
    expect(diff(baseline, current, counter()).changes).toEqual([]);
  });

  it("gives every change in a batch a distinct clock reading", () => {
    // Sharing one reading across a batch makes two edits to one record
    // indistinguishable, and the server has to choose arbitrarily.
    const out = diff({}, { j: { a: { v: 1 }, b: { v: 2 }, c: { v: 3 } } }, counter());
    const hlcs = out.changes.map((c) => c.hlc);
    expect(new Set(hlcs).size).toBe(hlcs.length);
    expect([...hlcs]).toEqual([...hlcs].sort());
  });

  it("treats a whole collection disappearing as a deletion of each record", () => {
    const out = diff({ j: { a: {}, b: {} } }, {}, counter());
    expect(out.deleted).toBe(2);
    expect(out.changes.every((c) => c.deleted)).toBe(true);
  });
});

// ══ structural equality ══════════════════════════════════════════════════

describe("sameRecord", () => {
  it("ignores key order", () => {
    // `JSON.stringify` comparison is the tempting one-liner and it is wrong
    // here: key order is insertion order, so a record rebuilt from a server
    // response would compare unequal to itself and the whole dataset would be
    // pushed on every sync.
    expect(sameRecord({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(JSON.stringify({ a: 1, b: 2 }) === JSON.stringify({ b: 2, a: 1 })).toBe(false);
  });

  it("respects array order", () => {
    // Arrays are order-sensitive on purpose — a task list is not a set.
    expect(sameRecord([1, 2], [2, 1])).toBe(false);
    expect(sameRecord([1, 2], [1, 2])).toBe(true);
  });

  it("compares nested structures", () => {
    expect(sameRecord({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toBe(true);
    expect(sameRecord({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } })).toBe(false);
  });

  it("distinguishes a missing key from an undefined one", () => {
    expect(sameRecord({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  it("handles null without throwing", () => {
    expect(sameRecord(null, null)).toBe(true);
    expect(sameRecord(null, {})).toBe(false);
    expect(sameRecord({ a: null }, { a: null })).toBe(true);
  });
});

// ══ the three properties ═════════════════════════════════════════════════

describe("the properties", () => {
  it("round-trips: apply what we pushed and the diff is empty", () => {
    const current: Snapshot = { j: { a: { v: 1 } }, p: { b: { v: 2 } } };
    const baseline = snapshotOf(current);
    expect(diff(baseline, current, counter()).changes).toEqual([]);
  });

  it("is idempotent: applying the same pull twice gives the same state", () => {
    const records = [
      { collection: "j", id: "a", body: { v: 1 } },
      { collection: "j", id: "b", deleted: true },
    ];
    const once = applyPulled({ j: { b: { v: 9 } } }, records);
    const twice = applyPulled(once, records);
    expect(twice).toEqual(once);
  });

  it("commutes: two disjoint pulls in either order give the same state", () => {
    const a = [{ collection: "j", id: "a", body: { v: 1 } }];
    const b = [{ collection: "p", id: "b", body: { v: 2 } }];
    expect(applyPulled(applyPulled({}, a), b)).toEqual(applyPulled(applyPulled({}, b), a));
  });

  it("does not mutate the snapshot it was given", () => {
    // The caller holds the previous snapshot as its BASELINE. Mutating it in
    // place moves the thing the next diff is measured against, so a pull would
    // silently erase the record of what we had already pushed.
    const original: Snapshot = { j: { a: { v: 1 } } };
    const frozen = snapshotOf(original);
    applyPulled(original, [{ collection: "j", id: "a", body: { v: 2 } }]);
    expect(original).toEqual(frozen);
  });

  it("drops a collection that becomes empty", () => {
    const out = applyPulled({ j: { a: {} } }, [{ collection: "j", id: "a", deleted: true }]);
    expect(out).toEqual({});
  });
});

// ══ the join rule ════════════════════════════════════════════════════════

describe("mayBootstrap", () => {
  it("allows seeding only when the server is genuinely empty", () => {
    expect(mayBootstrap(0, 0)).toBe(true);
  });

  it("refuses when the server has anything at all", () => {
    // "A device whose first pull returns anything never bootstraps."
    // A second device joining an established account must adopt, never seed —
    // otherwise it writes its own copy of every seeded record under a second
    // clock, and the merge keeps both.
    expect(mayBootstrap(12, 0)).toBe(false);
    expect(mayBootstrap(12, 5)).toBe(false);
    expect(mayBootstrap(0, 3)).toBe(false);
  });
});

// ══ the clock ════════════════════════════════════════════════════════════

describe("Clock", () => {
  it("round-trips the wire format", () => {
    expect(parseHlc(formatHlc(T0, 7, "macbook"))).toEqual({
      millis: T0,
      counter: 7,
      node: "macbook",
    });
  });

  it("sorts lexicographically in causal order", () => {
    // Fixed-width padding is what lets the server compare these with a plain
    // `<` in SQL. Without it "9" sorts above "10".
    const readings = [
      formatHlc(T0, 0, "a"),
      formatHlc(T0, 1, "a"),
      formatHlc(T0, 10, "a"),
      formatHlc(T0 + 1, 0, "a"),
    ];
    expect([...readings].sort()).toEqual(readings);
  });

  it("advances within one millisecond", () => {
    const c = new Clock("a");
    expect(c.tick(T0) < c.tick(T0)).toBe(true);
  });

  it("never goes backwards when the wall clock does", () => {
    // A phone waking from sleep, an NTP correction, a timezone change.
    const c = new Clock("a");
    const first = c.tick(T0);
    expect(c.tick(T0 - 60_000) > first).toBe(true);
  });

  it("survives a reload without emitting a lower reading", () => {
    // The clock is persisted with the cursor. One that resets to zero would
    // emit readings below ones already published, so a write made after a
    // reload would lose to one made before it.
    const c = new Clock("a");
    const before = c.tick(T0);
    const saved = c.toJSON();
    const restored = new Clock(saved.node, saved.millis, saved.counter);
    expect(restored.tick(T0) > before).toBe(true);
  });

  it("moves past a remote reading", () => {
    const c = new Clock("a");
    c.tick(T0);
    const remote = formatHlc(T0 + 5000, 3, "b");
    expect(c.observe(remote, T0) > remote).toBe(true);
  });

  it("refuses a clock beyond the drift ceiling, and stays put", () => {
    const c = new Clock("a");
    const before = c.tick(T0);
    expect(() => c.observe(formatHlc(T0 + MAX_DRIFT_MS + 1, 0, "b"), T0)).toThrow(ClockError);
    // The refusal has to leave our clock alone, or it is cosmetic: the
    // poisoned value is already in.
    expect(c.current()).toBe(before);
  });

  it("agrees with the server's constants", () => {
    // Two implementations of one wire format. `hlc.py` has MAX_DRIFT_MS = 10
    // minutes and the same field widths; a drift here is a whole class of
    // silently-wrong conflict resolution.
    expect(MAX_DRIFT_MS).toBe(600_000);
    expect(formatHlc(T0, 0, "n")).toHaveLength(16 + 1 + 5 + 1 + 1);
  });

  it("rejects a node id that would break the sort key", () => {
    for (const bad of ["has space", "", "x".repeat(65)]) {
      expect(() => formatHlc(T0, 0, bad)).toThrow(ClockError);
    }
  });
});

describe("deviceId", () => {
  it("is stable across calls", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const first = deviceId(storage);
    expect(deviceId(storage)).toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
  });

  it("does not depend on crypto.randomUUID", () => {
    // `crypto.randomUUID` is undefined on http:// over a tailnet IP — not a
    // secure context — which is exactly how the phone and iPad reach this box.
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    // `vi.stubGlobal`, not assignment: `globalThis.crypto` is a getter-only
    // property in Node, so `globalThis.crypto = undefined` throws rather than
    // simulating the absence it is meant to test.
    vi.stubGlobal("crypto", undefined);
    try {
      expect(deviceId(storage)).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
