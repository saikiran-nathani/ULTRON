/**
 * The Courses screen's two silent failure modes.
 *
 * **Arithmetic that lies.** A GPA, a weighted standing and a "you need X% on
 * the rest" are all numbers somebody plans around, and every one of them has
 * an input that produces a plausible wrong answer rather than an error: no
 * graded work at all, graded work that is all worth 0%, a target already
 * mathematically secured, a course worth 0 credits.
 *
 * **Ordering that drifts.** nexus rendered the course list and each
 * assignment list in array order. Per-record sync rebuilds those arrays in
 * ascending id order from records that arrive one at a time, so array order is
 * a different list on every device. These tests pin the field each list is
 * ordered by, including the tiebreaks — a comparator that returns 0 for two
 * distinct records is the same instability wearing a sort function's clothes.
 *
 * No jsdom in this repo, so the rendering is not covered; this holds the parts
 * that do not need one.
 */
import { describe, expect, it } from "vitest";
import type { Assignment, Course } from "@/lib/nexus/types";
import {
  calcGPA,
  compareSemesterDesc,
  defaultSemester,
  dueToneForDays,
  getWeightedStats,
  gradeNeeded,
  sortedAssignments,
  sortedCourses,
  sortedSemesters,
  statusTone,
  termKey,
  totalWeight,
} from "./courseMath";

const course = (over: Partial<Course> & { id: string }): Course => ({
  name: over.id,
  code: over.id.toUpperCase(),
  credits: 4,
  semester: "Fall 2025",
  grade: "",
  assignments: [],
  ...over,
});

const asg = (over: Partial<Assignment> & { id: string }): Assignment => ({
  name: over.id,
  status: "Not Started",
  dueDate: "",
  weight: "",
  grade: "",
  reminder: false,
  ...over,
});

describe("calcGPA", () => {
  it("weights by credits, not by course count", () => {
    // 4cr A (4.0) + 1cr F (0.0) = 16/5 = 3.20. A mean of the two grades would
    // say 2.00, which is the answer a per-course average gives and is wrong.
    const gpa = calcGPA([
      course({ id: "a", credits: 4, grade: "A" }),
      course({ id: "b", credits: 1, grade: "F" }),
    ]);
    expect(gpa).toBe("3.20");
  });

  it("reports an em-dash rather than 0.00 when nothing is graded", () => {
    // 0.00 is a GPA. "no data" is not, and the two must not render the same.
    expect(calcGPA([course({ id: "a" }), course({ id: "b" })])).toBe("—");
    expect(calcGPA([])).toBe("—");
  });

  it("lets a 0-credit graded course contribute nothing either way", () => {
    expect(calcGPA([course({ id: "a", credits: 4, grade: "A" }), course({ id: "b", credits: 0, grade: "F" })])).toBe(
      "4.00",
    );
    // A 0-credit course on its own is still "—": 0 points over 0 credits.
    expect(calcGPA([course({ id: "b", credits: 0, grade: "F" })])).toBe("—");
  });

  it("ignores a grade the table does not know", () => {
    // A blob written by an older build can carry anything in this field. The
    // cast is the point of the test: at runtime the value is just a string.
    const odd = course({ id: "x", credits: 4, grade: "S" as Course["grade"] });
    expect(calcGPA([odd, course({ id: "a", credits: 2, grade: "B" })])).toBe("3.00");
  });
});

describe("getWeightedStats", () => {
  it("averages over the graded weight only", () => {
    // 90 at 30% and 70 at 10% → 85 over the 40% that has been graded. The
    // remaining 60% must not be counted as zeros — that would say 34.
    const stats = getWeightedStats([
      asg({ id: "a", weight: 30, grade: 90 }),
      asg({ id: "b", weight: 10, grade: 70 }),
      asg({ id: "c", weight: 60 }),
    ]);
    expect(stats).toEqual({ avg: 85, gradedWeight: 40 });
  });

  it("needs both a weight and a grade", () => {
    expect(getWeightedStats([asg({ id: "a", grade: 90 }), asg({ id: "b", weight: 20 })])).toBeNull();
    expect(getWeightedStats([])).toBeNull();
  });

  it("returns null when the graded work is all worth 0%", () => {
    // The division would be 0/0. A NaN here renders as a percentage and reads
    // like a measurement.
    expect(getWeightedStats([asg({ id: "a", weight: 0, grade: 88 })])).toBeNull();
  });

  it("keeps a real 0 grade distinct from an unset one", () => {
    const stats = getWeightedStats([asg({ id: "a", weight: 50, grade: 0 })]);
    expect(stats).toEqual({ avg: 0, gradedWeight: 50 });
  });
});

describe("gradeNeeded", () => {
  it("solves for the remaining weight", () => {
    // 80% average over the graded 50%, target 90 overall → 100 on the rest.
    expect(gradeNeeded(90, { avg: 80, gradedWeight: 50 })).toBe(100);
  });

  it("can answer above 100 or below 0, and the caller reads those as words", () => {
    // Both are real answers, and both are what the screen turns into
    // "impossible" / "already secured" rather than printing.
    expect(gradeNeeded(95, { avg: 50, gradedWeight: 50 })).toBeGreaterThan(100);
    expect(gradeNeeded(60, { avg: 95, gradedWeight: 80 })).toBeLessThan(0);
  });

  it("has no answer once every point has been graded", () => {
    expect(gradeNeeded(90, { avg: 80, gradedWeight: 100 })).toBeNull();
    // Over 100% is a data-entry mistake, not a negative amount of work left.
    expect(gradeNeeded(90, { avg: 80, gradedWeight: 130 })).toBeNull();
  });
});

describe("totalWeight", () => {
  it("sums the weights and treats an unset one as zero", () => {
    expect(totalWeight([asg({ id: "a", weight: 30 }), asg({ id: "b" }), asg({ id: "c", weight: "20" })])).toBe(50);
  });
});

describe("tones", () => {
  it("never returns anything but a token", () => {
    const all = [
      statusTone("Not Started"),
      statusTone("In Progress"),
      statusTone("On Hold"),
      statusTone("Completed"),
      statusTone("Something from an older build"),
      dueToneForDays(-3),
      dueToneForDays(0),
      dueToneForDays(1),
      dueToneForDays(9),
    ];
    for (const tone of all) expect(tone).toMatch(/^var\(--color-[a-z-]+\)$/);
  });

  it("separates overdue, due-now and comfortable", () => {
    expect(dueToneForDays(-1)).not.toBe(dueToneForDays(0));
    expect(dueToneForDays(1)).not.toBe(dueToneForDays(2));
    expect(dueToneForDays(0)).toBe(dueToneForDays(1));
  });
});

describe("termKey", () => {
  it("orders seasons within a year and years across them", () => {
    expect(termKey("Spring 2026")).toBeGreaterThan(termKey("Fall 2025"));
    expect(termKey("Fall 2025")).toBeGreaterThan(termKey("Summer 2025"));
    expect(termKey("Summer 2025")).toBeGreaterThan(termKey("Spring 2025"));
    expect(termKey("Spring 2025")).toBeGreaterThan(termKey("Winter 2025"));
  });

  it("is case- and spacing-insensitive, and treats Autumn as Fall", () => {
    expect(termKey("  fall   2025 ")).toBe(termKey("Fall 2025"));
    expect(termKey("Autumn 2025")).toBe(termKey("Fall 2025"));
  });

  it("is NaN for anything it cannot read", () => {
    for (const bad of ["", "Fall", "2025", "Term 3 2025", "Quarter 2025", "Fall 25"]) {
      expect(termKey(bad)).toBeNaN();
    }
  });
});

describe("sortedSemesters / defaultSemester", () => {
  it("puts the most recent term first whatever order the array arrived in", () => {
    // This is the array-position bug in its original habitat: nexus read
    // `semesters[0]` as "the current semester", and per-record sync rebuilds
    // this array in whatever order the records land.
    const stored = ["Spring 2025", "Fall 2026", "Fall 2025", "Spring 2026"];
    expect(sortedSemesters(stored)).toEqual(["Fall 2026", "Spring 2026", "Fall 2025", "Spring 2025"]);
    expect(defaultSemester(stored)).toBe("Fall 2026");
    expect(defaultSemester([...stored].reverse())).toBe("Fall 2026");
  });

  it("drops blanks and duplicates", () => {
    expect(sortedSemesters(["Fall 2025", "", "Fall 2025"])).toEqual(["Fall 2025"]);
  });

  it("sorts labels it cannot parse last, but deterministically", () => {
    expect(sortedSemesters(["Co-op", "Fall 2025", "Bridge term"])).toEqual([
      "Fall 2025",
      "Bridge term",
      "Co-op",
    ]);
  });

  it("has an empty-safe default", () => {
    expect(defaultSemester([])).toBe("");
  });

  it("is a total order — no pair ties unless the strings are equal", () => {
    const labels = ["Fall 2025", "Spring 2026", "Co-op", "Bridge term", "Winter 2025"];
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) expect(compareSemesterDesc(a, b)).not.toBe(0);
      }
    }
  });
});

describe("sortedCourses", () => {
  it("orders by semester then code, not by array position", () => {
    const stored = [
      course({ id: "3", code: "CS5200", semester: "Fall 2025" }),
      course({ id: "1", code: "CS5800", semester: "Spring 2026" }),
      course({ id: "2", code: "CS5010", semester: "Fall 2025" }),
    ];
    // Spring 2026 leads; inside Fall 2025, CS5010 (id 2) precedes CS5200 (id 3).
    expect(sortedCourses(stored).map((c) => c.id)).toEqual(["1", "2", "3"]);
    // The load-bearing assertion: the same records in a different array order
    // render as the same list. That is what array order could never promise.
    expect(sortedCourses([...stored].reverse()).map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("breaks a full tie on id so the order cannot flicker", () => {
    const a = course({ id: "aaa", code: "X", name: "Same", semester: "Fall 2025" });
    const b = course({ id: "bbb", code: "X", name: "Same", semester: "Fall 2025" });
    expect(sortedCourses([b, a]).map((c) => c.id)).toEqual(["aaa", "bbb"]);
  });

  it("does not mutate its input", () => {
    const stored = [course({ id: "b", code: "B" }), course({ id: "a", code: "A" })];
    sortedCourses(stored);
    expect(stored.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

describe("sortedAssignments", () => {
  it("orders by due date, soonest first", () => {
    const stored = [
      asg({ id: "mid", dueDate: "2026-10-15" }),
      asg({ id: "hw1", dueDate: "2026-09-10" }),
      asg({ id: "final", dueDate: "2026-12-01" }),
    ];
    expect(sortedAssignments(stored).map((a) => a.id)).toEqual(["hw1", "mid", "final"]);
    expect(sortedAssignments([...stored].reverse()).map((a) => a.id)).toEqual(["hw1", "mid", "final"]);
  });

  it("parks undated work at the end rather than at the top", () => {
    // "" sorts before any date as a string, so the naive localeCompare puts
    // every undated item first — above work that is due tomorrow.
    const stored = [asg({ id: "someday" }), asg({ id: "soon", dueDate: "2026-09-10" })];
    expect(sortedAssignments(stored).map((a) => a.id)).toEqual(["soon", "someday"]);
  });

  it("orders same-day work by name, then id", () => {
    const stored = [
      asg({ id: "z", name: "Quiz", dueDate: "2026-09-10" }),
      asg({ id: "a", name: "Lab", dueDate: "2026-09-10" }),
      asg({ id: "b", name: "Lab", dueDate: "2026-09-10" }),
    ];
    expect(sortedAssignments(stored).map((a) => a.id)).toEqual(["a", "b", "z"]);
  });

  it("holds the order a pasted syllabus arrives in to its dates", () => {
    // `importSyllabus` pushes one record per line, so array order there is the
    // order of somebody's clipboard.
    const pasted = [
      asg({ id: "1", name: "Midterm", dueDate: "2026-10-15" }),
      asg({ id: "2", name: "HW1", dueDate: "2026-09-10" }),
    ];
    expect(sortedAssignments(pasted).map((a) => a.name)).toEqual(["HW1", "Midterm"]);
  });
});
