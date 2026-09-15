/**
 * Home's selectors, tested against the boundary that justifies the screen.
 *
 * > Home answers "what do I have open right now." The vault answers "how is my
 * > work going."
 *
 * The test for every widget is: **if its content would still be true next
 * week, it belongs in the vault.** So the assertions below are mostly about
 * exclusion — a todo due next Friday is not a today question, a habit ticked
 * yesterday is not ticked today, and the launcher carries no counts at all.
 * Those are the ways this screen drifts back into being the thing it exists to
 * replace, and they are all silent.
 *
 * The other recurring assertion is order-independence. Per-record sync rebuilds
 * arrays in key order, not arrival order, so any selector whose output depends
 * on input position would render differently on two fully-converged devices —
 * and both would report a clean sync forever.
 */
import { describe, expect, it } from "vitest";
import { TRACKS } from "@/config/nav";
import { completionId } from "@/lib/nexus/types";
import type { DashboardTodo, Habit, HabitCompletion } from "@/lib/nexus/types";
import {
  elapsedPct,
  habitsToday,
  launcherTiles,
  stopwatchMinutes,
  todayTodos,
} from "./selectors";

const TODAY = "2026-09-15";

const todo = (over: Partial<DashboardTodo> & { id: string }): DashboardTodo => ({
  text: over.id,
  done: false,
  dueDate: null,
  order: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

describe("todayTodos", () => {
  it("takes overdue, due-today and undated, and leaves the future alone", () => {
    // A todo due next Friday would still be due next week, so it is the
    // track screen's problem, not the home screen's.
    const all = [
      todo({ id: "overdue", dueDate: "2026-09-10" }),
      todo({ id: "today", dueDate: TODAY }),
      todo({ id: "undated", dueDate: null }),
      todo({ id: "friday", dueDate: "2026-09-25" }),
    ];
    expect(todayTodos(all, TODAY).map((t) => t.id)).toEqual([
      "overdue",
      "today",
      "undated",
    ]);
  });

  it("hides what is done, unless it was ticked in this visit", () => {
    const all = [
      todo({ id: "a", done: true }),
      todo({ id: "b", done: true }),
      todo({ id: "c" }),
    ];
    expect(todayTodos(all, TODAY).map((t) => t.id)).toEqual(["c"]);
    // `DashboardTodo` has no `doneAt`, so "done today" is unanswerable from the
    // model — a done todo kept on screen by a date rule would sit there
    // forever. Session state is the only honest place for the acknowledgement.
    expect(todayTodos(all, TODAY, new Set(["b"])).map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("orders by date then order then id, whatever order it is handed", () => {
    const all = [
      todo({ id: "z", dueDate: null, order: 1 }),
      todo({ id: "a", dueDate: null, order: 1 }),
      todo({ id: "m", dueDate: null, order: 0 }),
      todo({ id: "d", dueDate: "2026-09-01", order: 9 }),
    ];
    const ids = (l: DashboardTodo[]) => todayTodos(l, TODAY).map((t) => t.id);
    expect(ids(all)).toEqual(["d", "m", "a", "z"]);
    expect(ids([...all].reverse())).toEqual(["d", "m", "a", "z"]);
  });

  it("does not mutate what it is given", () => {
    // It sorts, and `Array.prototype.sort` is in-place — re-ordering the store's
    // own array from a render would be a write disguised as a read.
    const all = [todo({ id: "b", order: 1 }), todo({ id: "a", order: 0 })];
    todayTodos(all, TODAY);
    expect(all.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

describe("habitsToday", () => {
  const habits: Habit[] = [
    { id: "h2", name: "Read", color: "" },
    { id: "h1", name: "Deadlift", color: "" },
  ];

  it("reports only today's tick, using the model's own key", () => {
    const completions: HabitCompletion[] = [
      { id: completionId("h1", TODAY), habitId: "h1", date: TODAY },
      { id: completionId("h2", "2026-09-14"), habitId: "h2", date: "2026-09-14" },
    ];
    // Yesterday's tick is not today's state. If it leaked through, the widget
    // would be a streak — accumulated, and therefore the vault's.
    expect(habitsToday(habits, completions, TODAY)).toEqual([
      { habit: habits[1], done: true },
      { habit: habits[0], done: false },
    ]);
  });

  it("matches on the record id, not on habitId plus date by hand", () => {
    // A completion whose `id` disagrees with `${habitId}:${date}` is a broken
    // record; two devices minting different ids for the same tick is how the
    // flat-completions design fails. Keying on the id is what makes them
    // converge, so that is what this reads.
    const wrong: HabitCompletion[] = [{ id: "h1-2026-09-15", habitId: "h1", date: TODAY }];
    expect(habitsToday(habits, wrong, TODAY).every((t) => !t.done)).toBe(true);
  });

  it("is ordered by name, not by array position", () => {
    expect(habitsToday(habits, [], TODAY).map((t) => t.habit.name)).toEqual(["Deadlift", "Read"]);
    expect(habitsToday([...habits].reverse(), [], TODAY).map((t) => t.habit.name)).toEqual([
      "Deadlift",
      "Read",
    ]);
  });

  it("has nothing to say when there are no habits", () => {
    expect(habitsToday([], [], TODAY)).toEqual([]);
  });
});

describe("launcherTiles", () => {
  it("is the four tracks then Career, joined to NAV", () => {
    expect(launcherTiles().map((t) => t.id)).toEqual([...TRACKS, "career"]);
  });

  it("resolves a label, an icon and a blurb for every tile", () => {
    // The join is by id, so a screen renamed in `config/nav` silently drops out
    // of the launcher. This is the assertion that turns that into a failure.
    for (const tile of launcherTiles()) {
      expect(tile.label).not.toBe("");
      expect(tile.blurb).not.toBe("");
      expect(typeof tile.icon).not.toBe("undefined");
    }
  });

  it("carries no counts", () => {
    // A tile reading "3 active projects" would still be true next week, which
    // is the definition of vault content. Keeping the tiles numeral-free is the
    // boundary, so it is asserted rather than trusted.
    for (const tile of launcherTiles()) {
      expect(tile.blurb).not.toMatch(/\d/);
    }
  });
});

describe("elapsedPct", () => {
  it("reads a countdown as progress through it", () => {
    expect(elapsedPct(1500, 1500)).toBe(0);
    expect(elapsedPct(1500, 750)).toBe(50);
    expect(elapsedPct(1500, 0)).toBe(100);
  });

  it("refuses to divide by a duration of zero", () => {
    // `pomodoroSettings.focus` is user-editable and sync-merged, so 0 is
    // reachable — and NaN in a ring's dashoffset leaves the previous arc
    // painted, which reads as a timer that is still running.
    expect(elapsedPct(0, 0)).toBe(0);
    expect(elapsedPct(-60, 30)).toBe(0);
    expect(elapsedPct(Number.NaN, 30)).toBe(0);
    expect(elapsedPct(1500, Number.NaN)).toBe(0);
  });

  it("clamps a countdown that overran or was extended", () => {
    expect(elapsedPct(1500, -60)).toBe(100);
    expect(elapsedPct(1500, 2000)).toBe(0);
  });
});

describe("stopwatchMinutes", () => {
  it("floors to whole minutes", () => {
    const t0 = 1_700_000_000_000;
    expect(stopwatchMinutes(t0, t0)).toBe(0);
    expect(stopwatchMinutes(t0, t0 + 59_999)).toBe(0);
    expect(stopwatchMinutes(t0, t0 + 90_000)).toBe(1);
  });

  it("never reads negative when the clock moved backwards", () => {
    const t0 = 1_700_000_000_000;
    expect(stopwatchMinutes(t0, t0 - 60_000)).toBe(0);
    expect(stopwatchMinutes(null, t0)).toBe(0);
  });
});
