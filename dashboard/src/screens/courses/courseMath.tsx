/**
 * The Courses screen's arithmetic and its ordering, with no React in it.
 *
 * `.tsx` rather than `.ts` only because this directory's brief allows
 * `src/screens/courses/*.tsx` and nothing else — the extension carries no
 * meaning here, the same compromise `components/ui/index.tsx` documents.
 *
 * Two jobs live here, and both are here rather than inline in a component
 * because both are the kind of thing that fails quietly:
 *
 * 1. **Arithmetic** — GPA, the weighted standing, the "what do I need on the
 *    rest" calculator. Ported from nexus's `lib/academics.ts` unchanged in
 *    behaviour; what changed is that a test now holds the edges (no graded
 *    work, zero total weight, a target already secured).
 *
 * 2. **Ordering** — every comparator the screen sorts by. nexus rendered
 *    `academics.courses` and `course.assignments` in **array order**, which is
 *    insertion order on whichever device happened to insert. Per-record sync
 *    does not carry array position: records arrive one at a time in the
 *    server's `seq` order and the arrays are rebuilt in ascending id order, so
 *    array order on the phone and array order on the laptop are two different
 *    lists of the same records. Every list this screen renders is therefore
 *    ordered by a *field*, and the comparators are here so a test can pin them.
 */
import { GRADE_POINTS, type AssignmentStatus } from "@/lib/nexus/constants";
import { daysFromToday } from "@/lib/nexus/format";
import type { Assignment, Course } from "@/lib/nexus/types";

/* ────────────────────────────── Arithmetic ────────────────────────────── */

/**
 * Cumulative GPA over the graded courses, or "—" when nothing is graded yet.
 *
 * 0-credit courses add 0/0 and cannot skew the result, which is why the
 * credits are summed rather than the courses counted.
 */
export function calcGPA(courses: Course[] = []): string {
  let points = 0;
  let credits = 0;
  for (const c of courses) {
    if (!c.grade) continue;
    // Annotated rather than asserted: `GRADE_POINTS[Grade]` is typed as
    // `number`, so a bare `=== undefined` test is a no-overlap comparison the
    // compiler rejects — while at runtime a blob written by an older build can
    // still carry a grade string this table has never heard of.
    const grade: number | undefined = GRADE_POINTS[c.grade];
    if (grade === undefined) continue;
    const cr = Number(c.credits) || 0;
    points += grade * cr;
    credits += cr;
  }
  return credits > 0 ? (points / credits).toFixed(2) : "—";
}

export interface WeightedStats {
  /** Weighted mean over the graded slice, 0–100. */
  avg: number;
  /** How much of the course's 100% that slice accounts for. */
  gradedWeight: number;
}

/** Weighted standing across the assignments that carry BOTH a weight and a grade. */
export function getWeightedStats(assignments: Assignment[]): WeightedStats | null {
  const graded = assignments.filter(
    (a) => a.weight !== "" && a.weight != null && a.grade !== "" && a.grade != null,
  );
  if (graded.length === 0) return null;
  const gradedWeight = graded.reduce((s, a) => s + Number(a.weight || 0), 0);
  // Not just a divide-by-zero guard: a course whose graded work is all worth 0%
  // has no standing to report, and a `NaN` rendered as a percentage reads as a
  // real measurement.
  if (gradedWeight === 0) return null;
  const avg =
    graded.reduce((s, a) => s + Number(a.grade || 0) * Number(a.weight || 0), 0) / gradedWeight;
  return { avg, gradedWeight };
}

/**
 * The average needed across the remaining weight to land on `target` overall.
 *
 * `null` when nothing is left to be graded — there is no answer then, and the
 * caller must say so rather than print a number.
 */
export function gradeNeeded(target: number, stats: WeightedStats): number | null {
  const remaining = 100 - stats.gradedWeight;
  if (remaining <= 0) return null;
  return (target * 100 - stats.avg * stats.gradedWeight) / remaining;
}

/** Sum of every assignment weight — the input to the "weights don't total 100%" hint. */
export function totalWeight(assignments: Assignment[]): number {
  return assignments.reduce((s, a) => s + (Number(a.weight) || 0), 0);
}

/* ──────────────────────────────── Tones ───────────────────────────────── */

/**
 * Status → token. nexus's version named `--color-copper` / `--color-amber` /
 * `--color-steel-100`, none of which exist in this theme; the mapping is to
 * this theme's slots, and it is a token in every branch so a re-palette stays
 * a one-file change.
 */
export const STATUS_TONE: Record<AssignmentStatus, string> = {
  "Not Started": "var(--color-fg-muted)",
  "In Progress": "var(--color-accent)",
  "On Hold": "var(--color-warn)",
  Completed: "var(--color-good)",
};

export const statusTone = (status: string): string =>
  STATUS_TONE[status as AssignmentStatus] ?? "var(--color-fg-muted)";

/** Overdue / imminent / comfortable, from a whole-day offset. Pure, so it is testable. */
export function dueToneForDays(days: number): string {
  if (days < 0) return "var(--color-bad)";
  if (days <= 1) return "var(--color-warn)";
  return "var(--color-good)";
}

/** Same, from a date string. Undated work has no urgency to report. */
export const dueTone = (date: string): string =>
  date ? dueToneForDays(daysFromToday(date)) : "var(--color-fg-muted)";

/* ────────────────────────────── Ordering ─────────────────────────────── */

const SEASON_RANK: Record<string, number> = {
  winter: 0,
  spring: 1,
  summer: 2,
  fall: 3,
  autumn: 3,
};

/**
 * A sortable key for a semester label like "Fall 2025".
 *
 * `academics.semesters` is a bare `string[]`, so nexus read the current
 * semester as `semesters[0]` — the array's first element. That is the same
 * array-position bug as rendering a list in insertion order, in the one place
 * where it silently mis-files a record: the new-course form pre-filled
 * whichever semester happened to be first, and after a sync rebuilt the array
 * that could be any of them.
 *
 * `NaN` for anything that is not `<season> <year>`, which the comparators sort
 * last rather than guessing at.
 */
export function termKey(semester: string): number {
  const m = /^\s*([A-Za-z]+)\s+(\d{4})\s*$/.exec(semester);
  const name = m?.[1];
  const year = m?.[2];
  if (!name || !year) return Number.NaN;
  const season = SEASON_RANK[name.toLowerCase()];
  if (season === undefined) return Number.NaN;
  return Number(year) * 10 + season;
}

/** Most recent term first; unrecognised labels last, alphabetically among themselves. */
export function compareSemesterDesc(a: string, b: string): number {
  const ka = termKey(a);
  const kb = termKey(b);
  const aBad = Number.isNaN(ka);
  const bBad = Number.isNaN(kb);
  if (aBad !== bBad) return aBad ? 1 : -1;
  if (!aBad && !bBad && ka !== kb) return kb - ka;
  return a.localeCompare(b);
}

/** The semester list, deduped and newest-first. Never read positionally. */
export function sortedSemesters(semesters: string[]): string[] {
  return [...new Set(semesters.filter(Boolean))].sort(compareSemesterDesc);
}

/** The semester a new course should default to: the most recent one on record. */
export const defaultSemester = (semesters: string[]): string => sortedSemesters(semesters)[0] ?? "";

/**
 * Courses newest-semester-first, then by code.
 *
 * `id` is the final tiebreak on every comparator in this file. Without it two
 * records that tie on every visible field can swap places between renders on
 * one device and between devices on the same data, which is exactly the
 * instability that ordering by a field was meant to remove.
 */
export function sortedCourses(courses: Course[]): Course[] {
  return [...courses].sort((a, b) => {
    const s = compareSemesterDesc(a.semester, b.semester);
    if (s !== 0) return s;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    const name = a.name.localeCompare(b.name);
    if (name !== 0) return name;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Assignments by due date, soonest first, undated last.
 *
 * Also what makes `importSyllabus` safe to render: it pushes one record per
 * line of pasted text, so array order there is the order of somebody's
 * clipboard.
 */
export function sortedAssignments(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort((a, b) => {
    const ad = a.dueDate || "";
    const bd = b.dueDate || "";
    if (!ad !== !bd) return ad ? -1 : 1;
    if (ad !== bd) return ad.localeCompare(bd);
    const name = a.name.localeCompare(b.name);
    if (name !== 0) return name;
    return a.id.localeCompare(b.id);
  });
}
