/**
 * `Experiment.runId` resolution — the single most consequential piece of logic
 * on the Research screen, and the one whose failure modes are all reassuring
 * lies.
 *
 * The three that matter, and each has a test below:
 *
 * 1. Treating an empty `runId` as a broken link. `types.ts` documents `""` as
 *    the normal value for an experiment that was not a training run, so this
 *    puts a permanent warning on correct data.
 * 2. Treating "not in the live run list" as "the run is gone". The snapshot
 *    carries `store.runs(limit=25)` — the 25 most recent — so this reports
 *    every older experiment as broken, and gets worse the more the app is
 *    used.
 * 3. Treating "the fetch failed" as "the run is gone". Both arrive at the same
 *    `catch`, and only one of them is a fact about the data.
 */
import { describe, expect, it } from "vitest";
import type { Run } from "@/lib/api";
import {
  byId,
  classifyProbeError,
  isUnwritten,
  linkTally,
  normaliseRunId,
  orderReading,
  resolveRunLink,
  statusTally,
  unresolvedRunIds,
  type Probe,
  type RunLinkContext,
} from "./runlink";

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  name: id,
  started_at: 1_700_000_000,
  ended_at: null,
  status: "finished",
  last_step: 1000,
  last_beat: null,
  meta: {},
  ...over,
});

const ctx = (over: Partial<RunLinkContext> = {}): RunLinkContext => ({
  runs: [],
  hub: "reachable",
  probes: new Map<string, Probe>(),
  ...over,
});

describe("normaliseRunId", () => {
  it("trims, because a pasted id carries whitespace", () => {
    expect(normaliseRunId("  abc \n")).toBe("abc");
  });

  it("turns whitespace-only into no link at all", () => {
    expect(normaliseRunId("   ")).toBe("");
  });
});

describe("classifyProbeError", () => {
  it("reads a 404 as the run being absent", () => {
    // The exact shape `getJSON` throws.
    const err = new Error("404 Not Found — /api/runs/gone");
    expect(classifyProbeError(err)).toEqual({ kind: "absent" });
  });

  it("does not read any other status as absent", () => {
    // A 500 means the hub is there and broken, which says nothing about the
    // run. Calling it "gone" is the failure this whole module is about.
    expect(classifyProbeError(new Error("500 Internal Server Error — /api/runs/x"))).toEqual({
      kind: "error",
      detail: "the hub answered 500",
    });
    expect(classifyProbeError(new Error("401 Unauthorized — /api/runs/x")).kind).toBe("error");
    expect(classifyProbeError(new Error("502 Bad Gateway — /api/runs/x")).kind).toBe("error");
  });

  it("reads a transport failure as unreachable", () => {
    expect(classifyProbeError(new TypeError("Failed to fetch"))).toEqual({
      kind: "error",
      detail: "the hub could not be reached",
    });
  });

  it("does not mistake a run id that starts with digits for a status", () => {
    // `/^(\d{3})\b/` needs a word boundary, so "404abc" is not a 404.
    expect(classifyProbeError(new Error("404abc exploded")).kind).toBe("error");
  });

  it("survives a thrown non-Error", () => {
    expect(classifyProbeError("nope").kind).toBe("error");
    expect(classifyProbeError(undefined).kind).toBe("error");
  });
});

describe("resolveRunLink", () => {
  it("reports an empty runId as 'not linked', which is a normal state", () => {
    expect(resolveRunLink("", ctx())).toEqual({ state: "none" });
    expect(resolveRunLink("   ", ctx())).toEqual({ state: "none" });
    // And not as unreachable, even with the hub down — there is nothing to ask.
    expect(resolveRunLink("", ctx({ hub: "unreachable" }))).toEqual({ state: "none" });
    expect(resolveRunLink("", ctx({ hub: "asking" }))).toEqual({ state: "none" });
  });

  it("resolves from the live run list without asking", () => {
    const r = run("r1");
    const link = resolveRunLink("r1", ctx({ runs: [r] }));
    expect(link).toEqual({ state: "linked", runId: "r1", run: r });
  });

  it("matches the live list on the trimmed id", () => {
    const r = run("r1");
    expect(resolveRunLink(" r1 ", ctx({ runs: [r] })).state).toBe("linked");
  });

  it("says 'checking', not 'missing', for an id outside the recent 25", () => {
    // The whole point: the live list is capped, so absence from it is not
    // evidence of anything.
    expect(resolveRunLink("old-run", ctx({ runs: [run("r1")] }))).toEqual({
      state: "checking",
      runId: "old-run",
    });
  });

  it("says 'missing' only once the hub has answered 404", () => {
    const probes = new Map<string, Probe>([["gone", { kind: "absent" }]]);
    expect(resolveRunLink("gone", ctx({ probes }))).toEqual({ state: "missing", runId: "gone" });
  });

  it("resolves from a probe when the live list is capped past it", () => {
    const r = run("old-run", { status: "finished", last_step: 9000 });
    const probes = new Map<string, Probe>([["old-run", { kind: "run", run: r }]]);
    expect(resolveRunLink("old-run", ctx({ probes }))).toEqual({
      state: "linked",
      runId: "old-run",
      run: r,
    });
  });

  it("says 'unreachable' when the probe failed, carrying why", () => {
    const probes = new Map<string, Probe>([
      ["r9", { kind: "error", detail: "the hub answered 502" }],
    ]);
    expect(resolveRunLink("r9", ctx({ probes }))).toEqual({
      state: "unreachable",
      runId: "r9",
      detail: "the hub answered 502",
    });
  });

  it("says 'unreachable', not 'checking', when the hub is established down", () => {
    // A probe that has not started yet, on a hub known to be down, is not
    // pending — it is unanswerable.
    expect(resolveRunLink("r1", ctx({ hub: "unreachable" }))).toEqual({
      state: "unreachable",
      runId: "r1",
      detail: "the hub could not be reached",
    });
  });

  it("says 'checking', not 'unreachable', while the stream is still connecting", () => {
    // The regression. `hub` used to be a boolean, and on first mount the
    // snapshot is null while `connection` is "connecting" — so the boolean
    // was false and every card claimed the hub could not be reached, against
    // a hub that was answering 200. "Still asking" is not a verdict.
    expect(resolveRunLink("r1", ctx({ hub: "asking" }))).toEqual({
      state: "checking",
      runId: "r1",
    });
  });

  it("still trusts the live list when the hub has since gone offline", () => {
    // A snapshot that arrived and then the stream dropped: the run WAS there,
    // and downgrading a known link to "unreachable" would lose information we
    // already have.
    const r = run("r1");
    expect(resolveRunLink("r1", ctx({ runs: [r], hub: "unreachable" })).state).toBe("linked");
  });

  it("keeps a 404 authoritative even while the stream is connecting", () => {
    // The hub already answered about this id; a reconnecting stream does not
    // un-answer it.
    const probes = new Map<string, Probe>([["gone", { kind: "absent" }]]);
    expect(resolveRunLink("gone", ctx({ hub: "asking", probes })).state).toBe("missing");
  });

  it("keeps the four non-empty states mutually exclusive", () => {
    const states = [
      resolveRunLink("a", ctx({ runs: [run("a")] })).state,
      resolveRunLink("b", ctx()).state,
      resolveRunLink("c", ctx({ probes: new Map([["c", { kind: "absent" }]]) })).state,
      resolveRunLink("d", ctx({ hub: "unreachable" })).state,
    ];
    expect(new Set(states).size).toBe(4);
    expect(states).toEqual(["linked", "checking", "missing", "unreachable"]);
  });

  it("never reports 'unreachable' for any hub state other than unreachable", () => {
    // The invariant the banner depends on, asserted directly rather than
    // inferred from the cases above.
    for (const hub of ["asking", "reachable"] as const) {
      expect(resolveRunLink("x", ctx({ hub })).state).not.toBe("unreachable");
    }
  });
});

describe("unresolvedRunIds", () => {
  it("skips empty ids and ids already in the live list", () => {
    const ids = unresolvedRunIds(
      [{ runId: "" }, { runId: "r1" }, { runId: "old" }, { runId: "   " }],
      [run("r1")],
    );
    expect(ids).toEqual(["old"]);
  });

  it("dedupes, because a sweep shares one run id across experiments", () => {
    const ids = unresolvedRunIds([{ runId: "s" }, { runId: "s" }, { runId: " s " }], []);
    expect(ids).toEqual(["s"]);
  });

  it("is deterministic regardless of experiment order", () => {
    const a = unresolvedRunIds([{ runId: "b" }, { runId: "a" }], []);
    const b = unresolvedRunIds([{ runId: "a" }, { runId: "b" }], []);
    expect(a).toEqual(b);
    expect(a).toEqual(["a", "b"]);
  });

  it("is empty when nothing needs asking", () => {
    expect(unresolvedRunIds([], [])).toEqual([]);
    expect(unresolvedRunIds([{ runId: "" }], [])).toEqual([]);
  });
});

describe("byId", () => {
  it("orders ascending and does not mutate", () => {
    const xs = [{ id: "m2" }, { id: "m1" }];
    expect(byId(xs).map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(xs.map((x) => x.id)).toEqual(["m2", "m1"]);
  });

  it("is a total order, so two converged devices render the same list", () => {
    const xs = [{ id: "c" }, { id: "a" }, { id: "b" }];
    expect(byId(xs)).toEqual(byId([...xs].reverse()));
  });
});

describe("linkTally", () => {
  it("counts each state separately", () => {
    const t = linkTally([
      { state: "none" },
      { state: "none" },
      { state: "linked", runId: "a", run: run("a") },
      { state: "missing", runId: "b" },
      { state: "checking", runId: "c" },
      { state: "unreachable", runId: "d", detail: "x" },
    ]);
    expect(t).toEqual({ total: 6, none: 2, linked: 1, missing: 1, checking: 1, unreachable: 1 });
  });

  it("is all zeroes for no experiments", () => {
    expect(linkTally([])).toEqual({
      total: 0,
      none: 0,
      linked: 0,
      missing: 0,
      checking: 0,
      unreachable: 0,
    });
  });
});

describe("statusTally", () => {
  it("counts all four statuses, including the ones with none", () => {
    expect(statusTally([{ status: "done" }, { status: "done" }, { status: "running" }])).toEqual({
      planned: 0,
      running: 1,
      done: 2,
      abandoned: 0,
    });
  });
});

describe("isUnwritten", () => {
  it("flags a done experiment with no result", () => {
    expect(isUnwritten({ status: "done", result: "" })).toBe(true);
    expect(isUnwritten({ status: "done", result: "   \n" })).toBe(true);
  });

  it("does not flag an experiment that has not finished", () => {
    // A running experiment with no result yet is correct, not incomplete.
    expect(isUnwritten({ status: "running", result: "" })).toBe(false);
    expect(isUnwritten({ status: "planned", result: "" })).toBe(false);
    expect(isUnwritten({ status: "abandoned", result: "" })).toBe(false);
  });

  it("does not flag a done experiment that says something", () => {
    expect(isUnwritten({ status: "done", result: "loss plateaued at 2.1" })).toBe(false);
  });
});

describe("orderReading", () => {
  it("puts papers first, each block by id", () => {
    const items = [
      { id: "b", type: "Book" as const },
      { id: "p2", type: "Paper" as const },
      { id: "a", type: "Article" as const },
      { id: "p1", type: "Paper" as const },
    ];
    expect(orderReading(items).map((i) => i.id)).toEqual(["p1", "p2", "a", "b"]);
  });

  it("is stable against the order the array arrives in", () => {
    const items = [
      { id: "p1", type: "Paper" as const },
      { id: "b", type: "Book" as const },
      { id: "p2", type: "Paper" as const },
    ];
    expect(orderReading(items)).toEqual(orderReading([...items].reverse()));
  });

  it("does not mutate", () => {
    const items = [{ id: "b", type: "Book" as const }, { id: "p", type: "Paper" as const }];
    orderReading(items);
    expect(items.map((i) => i.id)).toEqual(["b", "p"]);
  });
});
