/**
 * The two ways data moves, and why they are two functions.
 *
 *     pull → write() → store changes → save → "something changed, sync!"
 *          → cycle → pull → write() → …
 *
 * Every lap of that burns a server `seq`, re-delivers the record to all five
 * devices, and each of those devices does the same. It never terminates, it
 * never errors, and from the outside it is indistinguishable from a chatty
 * network — so the only thing that catches it is a test that counts.
 *
 * `bridge.test.ts` counts requests, which is the loop's observable end. These
 * count notifications, which is its cause, and they cover the case the bridge
 * cannot see: an `update` that happens *during* an adopt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDefaultData } from "@/lib/nexus/migrate";
import { LS_KEY } from "@/lib/nexus/db";
import type { NexusData } from "@/lib/nexus/types";
import { SAVE_DEBOUNCE_MS, onLocalEdit, useData } from "./data";

/** A localStorage the tests can read back. Node has none. */
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

let storage: Map<string, string>;
let edits: number;
let unsubscribe: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  storage = stubStorage();
  edits = 0;
  unsubscribe = onLocalEdit(() => void (edits += 1));
  // A clean store per test: this is a module singleton, and a debounce left
  // armed by one test firing inside the next is its own small nightmare.
  useData.setState({ data: makeDefaultData(), loaded: true, cacheHit: true });
});

afterEach(() => {
  unsubscribe();
  useData.getState().flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update — a person edited something", () => {
  it("announces the edit, once, after the debounce settles", () => {
    // One notification per settled edit, not per keystroke: the bridge turns
    // each one into a sync cycle, and a cycle per character typed into a
    // journal entry is a request per character.
    const { update } = useData.getState();
    update((d) => void (d.settings.baseCurrency = "G"));
    update((d) => void (d.settings.baseCurrency = "GB"));
    update((d) => void (d.settings.baseCurrency = "GBP"));
    expect(edits).toBe(0);

    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(edits).toBe(1);
    expect(useData.getState().data?.settings.baseCurrency).toBe("GBP");
  });

  it("persists what it announced", () => {
    // The nudge fires after the save, not before. Sync reads the live blob, so
    // a nudge that raced the cache write would push a state the next reload
    // could not reproduce.
    useData.getState().update((d) => void (d.settings.baseCurrency = "INR"));
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(JSON.parse(storage.get(LS_KEY)!).settings.baseCurrency).toBe("INR");
  });

  it("leaves the previous state object alone", () => {
    // Immer's structural sharing, which is what makes a selector able to tell
    // that its own slice did not move. A mutation in place would also mean the
    // sync baseline — which holds values read out of this tree — could shift
    // underneath the engine.
    const before = useData.getState().data!;
    const currency = before.settings.baseCurrency;
    useData.getState().update((d) => void (d.settings.baseCurrency = "CHF"));
    expect(before.settings.baseCurrency).toBe(currency);
    expect(useData.getState().data).not.toBe(before);
  });
});

describe("adopt — sync merged something", () => {
  it("announces nothing", () => {
    // The loop, at its source. `adopt` has no argument that makes it notify;
    // this asserts the absence rather than trusting the signature.
    const merged = makeDefaultData();
    useData.getState().adopt(merged);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4);
    expect(edits).toBe(0);
  });

  it("stores the engine's blob by reference, not a reshaped copy", () => {
    // The engine has just advanced its baseline to exactly this object. Anything
    // done to it here is a difference the next diff finds — and finds again on
    // every cycle after that, forever. A quiet, endless version of the loop.
    const merged = makeDefaultData();
    useData.getState().adopt(merged);
    expect(useData.getState().data).toBe(merged);
  });

  it("caches immediately rather than through the debounce", () => {
    // The engine advances its cursor right after `adopt` returns. A pull whose
    // blob never reached storage would leave the next boot showing an empty app
    // that believes it is up to date — and so never asks for those records
    // again.
    const merged = makeDefaultData();
    merged.settings.baseCurrency = "JPY";
    useData.getState().adopt(merged);
    expect(JSON.parse(storage.get(LS_KEY)!).settings.baseCurrency).toBe("JPY");
  });

  it("stays quiet even when a subscriber edits in response", () => {
    // The path structure alone cannot close: a screen or slice that reacts to
    // adopted data by calling `update`. That update is a genuine local edit as
    // far as it knows, so it announces one — and the lap closes. The edit is
    // still applied and still cached; it simply does not ask for a cycle it
    // did not cause.
    //
    // The timing is the whole difficulty, and this test caught the first
    // version of the guard being wrong about it. `adopt` notifies its
    // subscribers synchronously, so the `update` below runs inside the adopt —
    // but its own notification is debounced by 250ms, and a guard that merely
    // asked "are we adopting?" when the timer fired was always answered no.
    // Hence the advance past the debounce here: without it this passes with
    // the loop fully wired.
    const off = useData.subscribe(() => {
      const d = useData.getState().data;
      if (d && d.settings.baseCurrency !== "AUD") {
        useData.getState().update((x) => void (x.settings.baseCurrency = "AUD"));
      }
    });
    try {
      useData.getState().adopt(makeDefaultData());
      vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4);
      expect(useData.getState().data?.settings.baseCurrency).toBe("AUD");
      expect(edits).toBe(0);
    } finally {
      off();
    }
  });

  it("does not discard an edit that is still waiting to be saved", () => {
    // A pull landing inside the 250ms window. The engine withholds the
    // server's copy of a record this device has changed and not yet pushed, so
    // the edit is in the adopted blob already — but the pending timer must
    // still write the *live* state when it fires, not the state it was armed
    // with.
    useData.getState().update((d) => void (d.settings.baseCurrency = "SGD"));
    const merged = structuredClone(useData.getState().data!) as NexusData;
    merged.dashboard.todos = [
      { id: "t1", text: "from the server", done: false, dueDate: null, order: 0, createdAt: "" },
    ];
    useData.getState().adopt(merged);
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);

    const cached = JSON.parse(storage.get(LS_KEY)!);
    expect(cached.settings.baseCurrency).toBe("SGD");
    expect(cached.dashboard.todos).toHaveLength(1);
    // And the pending timer's own notification still lands: that edit really
    // does need pushing.
    expect(edits).toBe(1);
  });
});

describe("flush", () => {
  it("saves and announces immediately, cancelling the debounce", () => {
    // Called when the app hides, which on iOS may be the last code that runs
    // before the tab is discarded — so this is the most important nudge there
    // is, not a redundant one.
    useData.getState().update((d) => void (d.settings.baseCurrency = "AED"));
    useData.getState().flush();
    expect(edits).toBe(1);
    expect(JSON.parse(storage.get(LS_KEY)!).settings.baseCurrency).toBe("AED");

    // The cancelled timer must not fire a second announcement later.
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 4);
    expect(edits).toBe(1);
  });
});
