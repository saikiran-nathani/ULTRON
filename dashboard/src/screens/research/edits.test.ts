/**
 * The research mutators — the slice `src/store/research.ts` should be.
 *
 * Three properties are load-bearing and all three fail quietly:
 *
 * 1. **They go through `update`, not `adopt`.** `adopt` is sync's entry point:
 *    it replaces the blob verbatim and tells the edit listeners nothing. An
 *    edit routed through it is saved locally and then never pushed — it looks
 *    perfect on this device and simply does not exist on the other four. So
 *    these tests count notifications, the same thing `store/data.test.ts`
 *    counts, because a missing notification has no other symptom.
 * 2. **They address records by id, never by position.** Per-record sync
 *    rebuilds every array in ascending id order, so an index captured by a
 *    screen is not a reference to anything.
 * 3. **They never touch `runId` except to set it.** Runs live in the hub's
 *    tables, so nothing here can validate one — and a mutator that "cleaned
 *    up" an id it could not resolve would destroy the only evidence that the
 *    link was ever made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDefaultData } from "@/lib/nexus/migrate";
import type { Experiment } from "@/lib/nexus/types";
import { SAVE_DEBOUNCE_MS, onLocalEdit, useData } from "@/store/data";
import { research } from "./edits";

/** A localStorage the store can write to. Node has none. */
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
}

const draft = (over: Partial<Omit<Experiment, "id">> = {}): Omit<Experiment, "id"> => ({
  name: "sweep",
  hypothesis: "wider beats deeper at this budget",
  status: "planned",
  started: null,
  ended: null,
  runId: "",
  result: "",
  projectId: null,
  ...over,
});

const list = () => useData.getState().data!.research.experiments;

let edits: number;
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  stubStorage();
  edits = 0;
  unsubscribe = onLocalEdit(() => void (edits += 1));
  useData.setState({ data: makeDefaultData(), loaded: true, cacheHit: true });
});

afterEach(() => {
  unsubscribe();
  useData.getState().flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("research.add", () => {
  it("mints an id and appends the record", () => {
    research.add(draft({ name: "first" }));
    expect(list()).toHaveLength(1);
    expect(list()[0]!.id).toMatch(/\S/);
    expect(list()[0]!.name).toBe("first");
  });

  it("gives every record a distinct id", () => {
    research.add(draft({ name: "a" }));
    research.add(draft({ name: "b" }));
    research.add(draft({ name: "c" }));
    expect(new Set(list().map((e) => e.id)).size).toBe(3);
  });

  it("keeps an empty runId empty rather than inventing one", () => {
    // `""` is the documented value for an experiment that was not a training
    // run, and the Research screen renders it as a distinct, non-alarming
    // state. A mutator filling it in would erase that distinction.
    research.add(draft());
    expect(list()[0]!.runId).toBe("");
  });

  it("announces a local edit, so the bridge pushes it", () => {
    research.add(draft());
    expect(edits).toBe(0); // debounced, not immediate
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(edits).toBe(1);
  });
});

describe("research.edit", () => {
  it("patches the named record and leaves its siblings alone", () => {
    research.add(draft({ name: "a" }));
    research.add(draft({ name: "b" }));
    const target = list()[1]!.id;
    research.edit(target, { result: "loss plateaued at 2.1", status: "done" });
    expect(list()[0]!.result).toBe("");
    expect(list()[1]).toMatchObject({ result: "loss plateaued at 2.1", status: "done" });
  });

  it("is a no-op for an id that is not there", () => {
    research.add(draft({ name: "a" }));
    // Reachable for real: the record can be deleted on another device between
    // the screen rendering and the user tapping save. A throw here would take
    // the screen down; silently doing nothing is what every other slice does.
    expect(() => research.edit("nope", { result: "x" })).not.toThrow();
    expect(list()[0]!.result).toBe("");
  });

  it("does not touch fields the patch omits", () => {
    research.add(draft({ runId: "run-7", hypothesis: "h" }));
    const id = list()[0]!.id;
    research.edit(id, { status: "running" });
    expect(list()[0]).toMatchObject({ runId: "run-7", hypothesis: "h", status: "running" });
  });

  it("announces the edit", () => {
    research.add(draft());
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    research.edit(list()[0]!.id, { status: "running" });
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(edits).toBe(2);
  });
});

describe("research.setStatus", () => {
  it("changes only the status", () => {
    research.add(draft({ runId: "r1", result: "kept" }));
    const id = list()[0]!.id;
    research.setStatus(id, "abandoned");
    expect(list()[0]).toMatchObject({ status: "abandoned", runId: "r1", result: "kept" });
  });
});

describe("research.unlinkRun", () => {
  it("clears the run id and nothing else", () => {
    research.add(draft({ runId: "gone-run", result: "kept", status: "done" }));
    const id = list()[0]!.id;
    research.unlinkRun(id);
    expect(list()[0]).toMatchObject({ runId: "", result: "kept", status: "done" });
  });

  it("does not delete the experiment", () => {
    // Clearing a broken link is the remedy for a 404 from the hub; deleting
    // the record would throw away the hypothesis and the result, which exist
    // nowhere else.
    research.add(draft({ runId: "gone-run" }));
    research.unlinkRun(list()[0]!.id);
    expect(list()).toHaveLength(1);
  });
});

describe("research.del", () => {
  it("removes by id, not by position", () => {
    research.add(draft({ name: "a" }));
    research.add(draft({ name: "b" }));
    research.add(draft({ name: "c" }));
    const middle = list()[1]!.id;
    research.del(middle);
    expect(list().map((e) => e.name)).toEqual(["a", "c"]);
  });

  it("is a no-op for an unknown id", () => {
    research.add(draft({ name: "a" }));
    research.del("nope");
    expect(list()).toHaveLength(1);
  });

  it("announces the edit", () => {
    research.add(draft());
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    research.del(list()[0]!.id);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(edits).toBe(2);
  });
});
