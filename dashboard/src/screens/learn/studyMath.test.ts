/**
 * The Self-learning screen's two silent failure modes.
 *
 * **A streak that is wrong.** It is the single most motivating number in the
 * app and it has no observable ground truth — nobody notices a streak that is
 * off by one, they just stop trusting it. nexus computed it from `Date.now()`
 * inside the function, mixing UTC-midnight `new Date("YYYY-MM-DD")` with
 * local-midnight `toDayStr()` in one comparison, so it was untestable *and*
 * disagreed with itself by a day in a negative-offset timezone after ~8pm.
 * Every function here takes `today`, so these tests pin the calendar.
 *
 * **Ordering that drifts.** nexus rendered plans, modules and topics in array
 * order. Per-record sync rebuilds those arrays in ascending id order from
 * records that arrive one at a time, so array order is a different list on
 * each of the five devices. These tests pin the field each list is ordered by,
 * including the `id` tiebreak — a comparator that returns 0 for two distinct
 * records is the same instability wearing a sort function's clothes.
 *
 * No jsdom in this repo, so the rendering is not covered; this holds the parts
 * that do not need one.
 */
import { describe, expect, it } from "vitest";
import type { StudyModule, StudyPlan, StudySession, Topic } from "@/lib/nexus/types";
import {
  calculateStreak,
  dayNumber,
  getRollingWeekMinutes,
  getXPLevel,
  heatmapDays,
  lastStudyDate,
  levelPct,
  parseTags,
  planProgress,
  plansByName,
  sessionDay,
  shiftDay,
  sortedModules,
  sortedPlans,
  sortedSessions,
  sortedTopics,
  totalXp,
} from "./studyMath";

const TODAY = "2026-03-15";

/** A session on a given day. The time-of-day is deliberately late: an
 *  evening timestamp is where the UTC/local mixup used to bite. */
const ses = (day: string, over: Partial<StudySession> = {}): StudySession => ({
  id: over.id ?? `s-${day}`,
  date: `${day}T21:40:00.000Z`,
  duration: 30,
  plan: null,
  topic: "Topic",
  xp: 60,
  ...over,
});

const topic = (over: Partial<Topic> & { id: string }): Topic => ({
  name: over.id,
  done: false,
  doneAt: null,
  ...over,
});

const mod = (over: Partial<StudyModule> & { id: string }): StudyModule => ({
  name: over.id,
  topics: [],
  ...over,
});

const plan = (over: Partial<StudyPlan> & { id: string }): StudyPlan => ({
  name: over.id,
  course: "",
  deadline: "",
  modules: [],
  ...over,
});

describe("dayNumber / shiftDay", () => {
  it("counts whole days, and round-trips", () => {
    const a = dayNumber("2026-03-15");
    const b = dayNumber("2026-03-16");
    expect(a).not.toBeNull();
    expect(b !== null && a !== null && b - a).toBe(1);
    expect(shiftDay(TODAY, 0)).toBe(TODAY);
    expect(shiftDay(TODAY, 1)).toBe("2026-03-14");
    expect(shiftDay(TODAY, 14)).toBe("2026-03-01");
  });

  it("steps across a DST boundary without repeating or skipping a day", () => {
    // US DST starts 2026-03-08. `toDayStr(new Date(Date.now() - n*86400000))`
    // — nexus's step — subtracts 24 real hours, so the day either repeats or
    // is skipped here depending on the direction of the jump.
    expect(shiftDay("2026-03-09", 1)).toBe("2026-03-08");
    expect(shiftDay("2026-03-09", 2)).toBe("2026-03-07");
    // And the November end-of-DST boundary.
    expect(shiftDay("2026-11-02", 1)).toBe("2026-11-01");
    expect(shiftDay("2026-11-02", 2)).toBe("2026-10-31");
  });

  it("steps across a month and a leap day", () => {
    expect(shiftDay("2026-03-01", 1)).toBe("2026-02-28");
    expect(shiftDay("2024-03-01", 1)).toBe("2024-02-29");
  });

  it("is null for anything that is not a date, and shiftDay passes it through", () => {
    for (const bad of ["", "not-a-date", "2026-00-10", "2026-03-00"]) {
      expect(dayNumber(bad)).toBeNull();
      expect(shiftDay(bad, 3)).toBe(bad);
    }
  });

  it("reads the day out of a full ISO timestamp", () => {
    expect(sessionDay(ses("2026-03-15"))).toBe("2026-03-15");
    expect(sessionDay({ ...ses("2026-03-15"), date: "" })).toBe("");
  });
});

describe("totalXp / lastStudyDate", () => {
  it("folds XP over the sessions rather than trusting a counter", () => {
    // `StudyPlanner.xp` was deleted from the schema: last-writer-wins on a
    // counter loses increments, so the total ends up disagreeing with the very
    // list it summarises. A fold cannot.
    expect(totalXp([ses("2026-03-14", { xp: 60 }), ses("2026-03-15", { xp: 40 })])).toBe(100);
    expect(totalXp([])).toBe(0);
  });

  it("survives a session whose xp is missing or junk", () => {
    expect(totalXp([ses("2026-03-14", { xp: Number.NaN }), ses("2026-03-15", { xp: 20 })])).toBe(20);
  });

  it("finds the latest timestamp without depending on array order", () => {
    const list = [ses("2026-03-10"), ses("2026-03-15"), ses("2026-03-12")];
    expect(lastStudyDate(list)).toBe("2026-03-15T21:40:00.000Z");
    expect(lastStudyDate([...list].reverse())).toBe("2026-03-15T21:40:00.000Z");
    expect(lastStudyDate([])).toBeNull();
  });
});

describe("calculateStreak", () => {
  it("counts consecutive days back from today", () => {
    const list = [ses("2026-03-15"), ses("2026-03-14"), ses("2026-03-13")];
    expect(calculateStreak(list, undefined, TODAY)).toBe(3);
  });

  it("still counts when the run ends yesterday — today is not over", () => {
    const list = [ses("2026-03-14"), ses("2026-03-13")];
    expect(calculateStreak(list, undefined, TODAY)).toBe(2);
  });

  it("is 0 once the run has gone cold", () => {
    expect(calculateStreak([ses("2026-03-13")], undefined, TODAY)).toBe(0);
    expect(calculateStreak([], undefined, TODAY)).toBe(0);
  });

  it("counts several sessions on one day once", () => {
    const list = [
      ses("2026-03-15", { id: "a" }),
      ses("2026-03-15", { id: "b" }),
      ses("2026-03-14", { id: "c" }),
    ];
    expect(calculateStreak(list, undefined, TODAY)).toBe(2);
  });

  it("does not depend on the order the sessions arrive in", () => {
    const list = [ses("2026-03-13"), ses("2026-03-15"), ses("2026-03-14")];
    expect(calculateStreak(list, undefined, TODAY)).toBe(3);
    expect(calculateStreak([...list].reverse(), undefined, TODAY)).toBe(3);
  });

  it("bridges one interior gap with the frozen day", () => {
    // Studied 15th, 13th, 12th; the 14th was frozen.
    const list = [ses("2026-03-15"), ses("2026-03-13"), ses("2026-03-12")];
    expect(calculateStreak(list, "2026-03-14", TODAY)).toBe(3);
    // Without the freeze the run stops at the gap.
    expect(calculateStreak(list, undefined, TODAY)).toBe(1);
  });

  it("does not bridge a gap the freeze is not in", () => {
    const list = [ses("2026-03-15"), ses("2026-03-13"), ses("2026-03-12")];
    expect(calculateStreak(list, "2026-03-10", TODAY)).toBe(1);
  });

  it("keeps a cold run alive when yesterday itself was frozen", () => {
    // Nothing yesterday or today, but yesterday was frozen and the run reaches
    // the day before.
    const list = [ses("2026-03-13"), ses("2026-03-12")];
    expect(calculateStreak(list, "2026-03-14", TODAY)).toBe(2);
    // A freeze does not reach two days back.
    expect(calculateStreak([ses("2026-03-12")], "2026-03-14", TODAY)).toBe(0);
  });

  it("does not bridge two missing days with one freeze", () => {
    const list = [ses("2026-03-15"), ses("2026-03-12")];
    expect(calculateStreak(list, "2026-03-14", TODAY)).toBe(1);
  });

  it("ignores sessions with an unreadable date instead of counting them", () => {
    const list = [ses("2026-03-15"), { ...ses("2026-03-14"), date: "" }];
    expect(calculateStreak(list, undefined, TODAY)).toBe(1);
  });
});

describe("getRollingWeekMinutes", () => {
  it("sums the window inclusive of today", () => {
    // A 7-day window ending on the 15th is the 9th through the 15th, so the
    // 8th is one day outside it.
    const list = [ses("2026-03-15", { duration: 25 }), ses("2026-03-08", { duration: 30 })];
    expect(getRollingWeekMinutes(list, 7, TODAY)).toBe(25);
    expect(getRollingWeekMinutes(list, 8, TODAY)).toBe(55);
  });

  it("holds the window's far edge exactly — 7 days means 7, not 6 or 8", () => {
    // The off-by-one here is the whole hazard: `days` counts today, so the
    // cut-off is `today - (days - 1)`. Getting it wrong either quietly drops
    // the oldest day of the week or credits an eighth one.
    const edge = [ses("2026-03-09", { duration: 10 })];
    expect(getRollingWeekMinutes(edge, 7, TODAY)).toBe(10);
    expect(getRollingWeekMinutes(edge, 6, TODAY)).toBe(0);
    expect(getRollingWeekMinutes([ses("2026-03-08", { duration: 10 })], 7, TODAY)).toBe(0);
  });

  it("excludes a session dated in the future rather than crediting it", () => {
    // A backdate box and five clocks that disagree make this reachable, and a
    // future session inflating "this week" is a goal ring that reads full.
    const list = [ses("2026-03-20", { duration: 90 }), ses("2026-03-15", { duration: 10 })];
    expect(getRollingWeekMinutes(list, 7, TODAY)).toBe(10);
  });
});

describe("heatmapDays", () => {
  it("returns exactly `days` columns, oldest first, ending today", () => {
    const days = heatmapDays([], 91, TODAY);
    expect(days).toHaveLength(91);
    expect(days[0]?.date).toBe(shiftDay(TODAY, 90));
    expect(days[90]?.date).toBe(TODAY);
  });

  it("has no duplicate or missing column across a DST boundary", () => {
    // The bug this replaces: building the day list by repeatedly subtracting
    // 86400000ms and reading local calendar fields off the result.
    const days = heatmapDays([], 30, "2026-03-20");
    const dates = days.map((d) => d.date);
    expect(new Set(dates).size).toBe(30);
  });

  it("sums several sessions onto one day", () => {
    const list = [
      ses("2026-03-14", { id: "a", duration: 25 }),
      ses("2026-03-14", { id: "b", duration: 35 }),
    ];
    const days = heatmapDays(list, 7, TODAY);
    expect(days.find((d) => d.date === "2026-03-14")?.mins).toBe(60);
  });

  it("drops out-of-window minutes instead of folding them into the edge day", () => {
    // Clamping the old date into the window would draw a column somebody
    // never studied, on the oldest day, every time.
    const list = [ses("2025-01-01", { duration: 500 }), ses("2026-03-20", { duration: 500 })];
    const days = heatmapDays(list, 7, TODAY);
    expect(days.reduce((s, d) => s + d.mins, 0)).toBe(0);
  });
});

describe("getXPLevel / levelPct", () => {
  it("names a level for every threshold and never a colour literal", () => {
    for (const xp of [0, 49, 50, 199, 200, 499, 500, 999, 1000, 1999, 2000, 99999]) {
      const lvl = getXPLevel(xp);
      expect(lvl.color).toMatch(/^var\(--color-[a-z-]+\)$/);
      expect(lvl.min).toBeLessThanOrEqual(xp);
      if (lvl.next !== null) expect(lvl.next).toBeGreaterThan(xp);
    }
  });

  it("steps exactly on the threshold", () => {
    expect(getXPLevel(49).level).toBe(1);
    expect(getXPLevel(50).level).toBe(2);
    expect(getXPLevel(1999).level).toBe(5);
    expect(getXPLevel(2000).level).toBe(6);
  });

  it("reads 0 at the bottom of a level and 100 at the top of the ladder", () => {
    expect(levelPct(50, getXPLevel(50))).toBe(0);
    expect(levelPct(125, getXPLevel(125))).toBe(50);
    // Max level has no `next`; a span of null must not become NaN% of a bar.
    expect(levelPct(5000, getXPLevel(5000))).toBe(100);
  });
});

describe("planProgress", () => {
  it("counts topics across every module", () => {
    const p = plan({
      id: "p",
      modules: [
        mod({ id: "m1", topics: [topic({ id: "a", done: true }), topic({ id: "b" })] }),
        mod({ id: "m2", topics: [topic({ id: "c", done: true })] }),
      ],
    });
    expect(planProgress(p)).toEqual({ done: 2, total: 3, pct: (2 / 3) * 100 });
  });

  it("is 0% and not NaN% for a plan with no topics", () => {
    expect(planProgress(plan({ id: "p" }))).toEqual({ done: 0, total: 0, pct: 0 });
    expect(planProgress(plan({ id: "p", modules: [mod({ id: "m" })] })).pct).toBe(0);
  });
});

describe("ordering", () => {
  it("orders plans by deadline, undated last, independent of array order", () => {
    const stored = [
      plan({ id: "3", name: "Later", deadline: "2026-05-01" }),
      plan({ id: "1", name: "Someday" }),
      plan({ id: "2", name: "Soon", deadline: "2026-04-01" }),
    ];
    expect(sortedPlans(stored).map((p) => p.id)).toEqual(["2", "3", "1"]);
    expect(sortedPlans([...stored].reverse()).map((p) => p.id)).toEqual(["2", "3", "1"]);
  });

  it("breaks a full plan tie on id", () => {
    const a = plan({ id: "aaa", name: "Same" });
    const b = plan({ id: "bbb", name: "Same" });
    expect(sortedPlans([b, a]).map((p) => p.id)).toEqual(["aaa", "bbb"]);
  });

  it("orders the picker by name, not by deadline", () => {
    const stored = [plan({ id: "1", name: "Zoology" }), plan({ id: "2", name: "Algebra" })];
    expect(plansByName(stored).map((p) => p.name)).toEqual(["Algebra", "Zoology"]);
  });

  it("orders modules and topics by name, since neither record has an order field", () => {
    const mods = [mod({ id: "2", name: "Trees" }), mod({ id: "1", name: "Graphs" })];
    expect(sortedModules(mods).map((m) => m.name)).toEqual(["Graphs", "Trees"]);
    const tops = [topic({ id: "2", name: "BFS" }), topic({ id: "1", name: "AVL" })];
    expect(sortedTopics(tops).map((t) => t.name)).toEqual(["AVL", "BFS"]);
  });

  it("keeps a checked topic in place rather than moving it", () => {
    // Re-sorting on `done` would make a checkbox jump out from under the
    // finger that just tapped it, and the next tap lands on its neighbour.
    const tops = [topic({ id: "1", name: "AVL", done: true }), topic({ id: "2", name: "BFS" })];
    expect(sortedTopics(tops).map((t) => t.name)).toEqual(["AVL", "BFS"]);
  });

  it("orders sessions newest first, with an id tiebreak for one timestamp", () => {
    const stored = [
      ses("2026-03-13", { id: "old" }),
      ses("2026-03-15", { id: "zz" }),
      ses("2026-03-15", { id: "aa" }),
    ];
    expect(sortedSessions(stored).map((s) => s.id)).toEqual(["aa", "zz", "old"]);
    expect(sortedSessions([...stored].reverse()).map((s) => s.id)).toEqual(["aa", "zz", "old"]);
  });

  it("does not mutate its input", () => {
    const stored = [plan({ id: "b", name: "B" }), plan({ id: "a", name: "A" })];
    sortedPlans(stored);
    plansByName(stored);
    expect(stored.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("parseTags", () => {
  it("keeps only the #-prefixed words, exactly as the timer store does", () => {
    expect(parseTags("#exam #review notes")).toEqual(["#exam", "#review"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });

  it("inherits the store's lone-# quirk rather than diverging from it", () => {
    // `store/timer.ts` filters on `startsWith("#")` and nothing else. A
    // stricter preview here would show a different set from the one saved.
    expect(parseTags("# #ok")).toEqual(["#", "#ok"]);
  });
});
