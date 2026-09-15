/**
 * Two bugs that shared one root: array position treated as data.
 *
 * Per-record sync does not carry array position. Records arrive one at a time
 * in the server's `seq` order and every array is rebuilt in ascending id
 * order — so anything derived from `length` or an index is a value two devices
 * will compute identically and independently, and then disagree about.
 *
 * Both were found by agents porting screens, in store files they could not
 * edit. Neither had a test.
 */
import { describe, expect, it } from "vitest";
import { makeDefaultData } from "@/lib/nexus/migrate";
import type { NexusData } from "@/lib/nexus/types";
// Imported, not restated. The first version of this file reimplemented both
// rules and passed with both bugs put back — a test that describes the
// behaviour instead of binding to it protects nothing.
import { nextTodoOrder as nextOrder } from "./dashboard";
import { minutesLogged } from "./timer";

describe("todo ordering", () => {
  it("does not derive order from array length", () => {
    // The failure: two devices add a todo while offline. Both read
    // `todos.length` — the same number, because their arrays are the same —
    // and both claim that slot. After the merge the tie is broken by id, which
    // is arbitrary, so neither user sees the order they arranged.
    const three = [0, 1, 2].map((order) => ({
      id: `t${order}`,
      text: `x${order}`,
      done: false,
      dueDate: null,
      order,
      createdAt: "2026-09-15T00:00:00.000Z",
    }));
    expect(nextOrder(three)).toBe(3);

    // And the case length gets wrong: a todo was deleted, so length is 2 while
    // the highest order in use is 2. Length would reissue an order already
    // taken, which is the collision above without needing a second device.
    const afterDelete = [three[0]!, three[2]!];
    expect(afterDelete.length).toBe(2);
    expect(nextOrder(afterDelete)).toBe(3);
  });

  it("starts at zero on an empty list", () => {
    expect(nextOrder([])).toBe(0);
  });

  it("the default store's todos are internally consistent", () => {
    // Guards the fixture rather than the logic: a seeded store with duplicate
    // orders would make every assertion above vacuous.
    const d: NexusData = makeDefaultData();
    const orders = d.dashboard.todos.map((t) => t.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

describe("logging a focus session", () => {
  const LEN = { focus: 25, short: 5, long: 15 };
  const logged = (mode: "focus" | "short" | "long", secondsLeft: number, lengths: typeof LEN) =>
    minutesLogged(mode, secondsLeft, lengths[mode] * 60);

  it("refuses to log anything outside focus mode", () => {
    // The bug: elapsed was `focusLength - secondsLeft` regardless of mode. Four
    // minutes into a five-minute break that is 25 − 4 = 21 minutes of study
    // written to the log as fact. A study log with invented minutes in it is
    // worse than none — the minutes are indistinguishable from real ones,
    // permanently.
    expect(logged("short", 60, LEN)).toBeNull();
    expect(logged("long", 600, LEN)).toBeNull();
  });

  it("measures against the mode that actually ran", () => {
    expect(logged("focus", 25 * 60, LEN)).toBe(1); // nothing elapsed → floor of 1
    expect(logged("focus", 10 * 60, LEN)).toBe(15);
    expect(logged("focus", 0, LEN)).toBe(25);
  });
});
