/**
 * The runway's arithmetic. A wrong answer here is a picture that is not the
 * data, rendered without an error — which is why it is tested and the markup
 * around it is not.
 *
 * The date cases are the ones that actually bit nexus: `new Date("YYYY-MM-DD")`
 * is UTC midnight, so in any negative-offset zone the playhead lands a day
 * early, and a cleared date input yields `NaN` that poisons the whole axis.
 */
import { describe, expect, it } from "vitest";
import { dayMs, runwayModel, shortMonth } from "./timeline";

const phase = (
  id: string,
  start: string,
  end: string,
  tasks: boolean[] = [],
) => ({ id, title: id, start, end, tasks: tasks.map((done) => ({ done })) });

/** A local-midnight timestamp, the way the app's own helpers build them. */
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

describe("dayMs", () => {
  it("parses in the local calendar, not UTC", () => {
    // The bug this replaces: `new Date("2026-09-15").getTime()` is UTC
    // midnight, which is the 14th at 20:00 in US Eastern.
    expect(dayMs("2026-09-15")).toBe(at(2026, 9, 15));
  });

  it("returns null for the states a cleared date input can produce", () => {
    expect(dayMs("")).toBeNull();
    expect(dayMs("not-a-date")).toBeNull();
    expect(dayMs("2026-09")).toBeNull();
  });

  it("ignores a time suffix rather than choking on it", () => {
    expect(dayMs("2026-09-15T13:45:00Z")).toBe(at(2026, 9, 15));
  });
});

describe("shortMonth", () => {
  it("renders the month and year", () => {
    expect(shortMonth("2026-09-15")).toBe("Sep 2026");
  });

  it("is empty for an empty date rather than 'Invalid Date'", () => {
    expect(shortMonth("")).toBe("");
  });
});

describe("runwayModel", () => {
  const phases = [
    phase("a", "2026-01-01", "2026-03-31", [true, false]),
    phase("b", "2026-04-01", "2026-06-30", [true, true]),
  ];

  it("returns null when nothing can be placed", () => {
    expect(runwayModel([], "2026-09-01", "2026-02-01", at(2026, 2, 1))).toBeNull();
    // Every phase undated is not "an empty axis" — it is nothing to draw.
    expect(
      runwayModel([phase("x", "", "")], "2026-09-01", "2026-02-01", at(2026, 2, 1)),
    ).toBeNull();
  });

  it("places segments proportionally across the window, deadline included", () => {
    // Axis spans 2026-01-01 → 2026-09-01 because the deadline is past the
    // last phase's end.
    const m = runwayModel(phases, "2026-09-01", "2026-02-01", at(2026, 2, 1))!;
    expect(m.segments.map((s) => s.id)).toEqual(["a", "b"]);
    expect(m.segments[0]!.left).toBe(0);
    expect(m.segments[0]!.width).toBeGreaterThan(30);
    expect(m.segments[1]!.left).toBeCloseTo(37, 0);
    // The axis extends to the deadline, so nothing reaches 100%.
    expect(m.segments[1]!.left + m.segments[1]!.width).toBeLessThan(100);
  });

  it("counts task completion per segment", () => {
    const m = runwayModel(phases, "2026-09-01", "2026-02-01", at(2026, 2, 1))!;
    expect(m.segments[0]).toMatchObject({ done: 1, total: 2, pct: 50 });
    expect(m.segments[1]).toMatchObject({ done: 2, total: 2, pct: 100 });
  });

  it("reports 0% rather than NaN for a phase with no tasks", () => {
    const m = runwayModel([phase("a", "2026-01-01", "2026-02-01")], "2026-03-01", "2026-01-15", at(2026, 1, 15))!;
    expect(m.segments[0]!.pct).toBe(0);
  });

  it("classifies past, current and future against today", () => {
    const three = [
      phase("past", "2026-01-01", "2026-01-31"),
      phase("now", "2026-02-01", "2026-02-28"),
      phase("soon", "2026-03-01", "2026-03-31"),
    ];
    const m = runwayModel(three, "2026-04-01", "2026-02-10", at(2026, 2, 10))!;
    expect(m.segments.map((s) => s.status)).toEqual(["past", "current", "future"]);
  });

  it("calls the last day of a phase 'current', not 'past'", () => {
    // `end < today` rather than `end <= today`: a phase is current through its
    // final day, and off-by-one here moves the "Now" card a phase early.
    const m = runwayModel([phase("p", "2026-02-01", "2026-02-28")], "2026-04-01", "2026-02-28", at(2026, 2, 28))!;
    expect(m.segments[0]!.status).toBe("current");
  });

  it("returns null for the playhead when now is outside the window", () => {
    const before = runwayModel(phases, "2026-09-01", "2025-06-01", at(2025, 6, 1))!;
    expect(before.todayPct).toBeNull();
    const after = runwayModel(phases, "2026-09-01", "2027-06-01", at(2027, 6, 1))!;
    expect(after.todayPct).toBeNull();
    // Distinct from "today is at 0%", which is a real position.
    const on = runwayModel(phases, "2026-09-01", "2026-01-01", at(2026, 1, 1))!;
    expect(on.todayPct).toBe(0);
  });

  it("does not divide by zero on a single one-day phase", () => {
    const m = runwayModel([phase("p", "2026-05-05", "2026-05-05")], "", "2026-05-05", at(2026, 5, 5))!;
    expect(Number.isFinite(m.segments[0]!.left)).toBe(true);
    expect(Number.isFinite(m.segments[0]!.width)).toBe(true);
    expect(m.todayPct).toBe(0);
  });

  it("counts undated phases instead of dropping them silently", () => {
    const m = runwayModel(
      [phase("a", "2026-01-01", "2026-03-31"), phase("b", "", ""), phase("c", "2026-04-01", "")],
      "2026-09-01",
      "2026-02-01",
      at(2026, 2, 1),
    )!;
    expect(m.segments.map((s) => s.id)).toEqual(["a"]);
    expect(m.undated).toBe(2);
  });

  it("orders segments chronologically whatever order the array arrives in", () => {
    // Per-record sync rebuilds arrays in id order, so the caller cannot be
    // trusted to have sorted them — and a reversed list staggers its entrance
    // animation backwards.
    const reversed = [...phases].reverse();
    const m = runwayModel(reversed, "2026-09-01", "2026-02-01", at(2026, 2, 1))!;
    expect(m.segments.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("labels the window from the first placed phase to the deadline", () => {
    const m = runwayModel(phases, "2026-09-01", "2026-02-01", at(2026, 2, 1))!;
    expect(m.from).toBe("Jan 2026");
    expect(m.to).toBe("Sep 2026");
  });

  it("falls back to the last phase's end when there is no deadline", () => {
    const m = runwayModel(phases, "", "2026-02-01", at(2026, 2, 1))!;
    expect(m.to).toBe("Jun 2026");
  });

  it("keeps every segment inside the axis", () => {
    const m = runwayModel(phases, "2026-09-01", "2026-02-01", at(2026, 2, 1))!;
    for (const s of m.segments) {
      expect(s.left).toBeGreaterThanOrEqual(0);
      expect(s.left).toBeLessThanOrEqual(100);
    }
  });
});
