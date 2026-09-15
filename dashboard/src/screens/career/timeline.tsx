/**
 * The runway ribbon's geometry, split out from the component that draws it.
 *
 * Two reasons, and the second is the real one:
 *
 * 1. nexus computed this with `date-fns` (`parseISO`, `format`). That
 *    dependency is not in this app and adding one is out of scope, so the two
 *    calls it made are re-derived here from `lib/nexus/format`'s own
 *    local-calendar helpers. `parseISO` is not a drop-in for `new Date(str)`
 *    either — `new Date("2026-09-15")` is UTC midnight, which in a
 *    negative-offset zone is the 14th locally, and a playhead that is a day
 *    out is a playhead nobody trusts.
 * 2. A wrong timeline does not throw. It renders a picture that is simply not
 *    the data — segments in the wrong place, a "today" marker on the wrong
 *    phase — and on a planning screen that is the worst failure available. So
 *    the arithmetic is pure and unit-tested, and the component is left with
 *    nothing but markup.
 *
 * No JSX in this file; `.tsx` only because this directory's brief allows that
 * extension and no other.
 */
import { monthLabel } from "@/lib/nexus/format";
import type { RoadmapPhase } from "@/lib/nexus/types";
import { orderPhases } from "./order";

/**
 * `YYYY-MM-DD` → epoch ms at LOCAL midnight, or `null` if it is not a date.
 *
 * `null` rather than `NaN`: a single `NaN` in a `Math.min` poisons the whole
 * axis, and every segment then gets `left: NaN%`, which CSS drops — leaving
 * the ribbon's phases stacked invisibly at the origin with no error anywhere.
 * An unparseable date is a real state (the phase form's date input can be
 * cleared), so it is returned as one.
 */
export function dayMs(date: string): number | null {
  if (!date) return null;
  const parts = date.slice(0, 10).split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

/** "2026-09-15" → "Sep 2026". The `date-fns` `format(…, "MMM yyyy")` call. */
export const shortMonth = (date: string): string => monthLabel(date.slice(0, 7));

export type SegmentStatus = "past" | "current" | "future";

export interface RunwaySegment {
  id: string;
  title: string;
  /** Percent of the axis. */
  left: number;
  width: number;
  /** Task completion, 0–100. */
  pct: number;
  done: number;
  total: number;
  status: SegmentStatus;
}

export interface RunwayModel {
  segments: RunwaySegment[];
  /** Percent of the axis, or `null` when now sits outside the window. */
  todayPct: number | null;
  /** First placed start and the far edge of the axis, for the window label. */
  from: string;
  to: string;
  /**
   * Phases left off the ribbon because they have no usable start/end.
   *
   * Surfaced rather than silently dropped: a phase missing from a timeline is
   * indistinguishable from a phase that does not exist, and the fix (fill in
   * the dates) is invisible unless something says so.
   */
  undated: number;
}

type PhaseLike = Pick<RoadmapPhase, "id" | "title" | "start" | "end"> & {
  tasks: readonly { done: boolean }[];
};

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * Place every dated phase on a proportional time axis.
 *
 * Returns `null` when there is nothing to draw at all, so the caller renders
 * an empty state rather than an axis with no marks on it — which reads as a
 * loading failure.
 *
 * `today` and `nowMs` are parameters rather than reads of the clock, because a
 * function that asks the time cannot be tested for the interesting cases: the
 * day a phase ends, the day the deadline passes.
 */
export function runwayModel(
  phases: readonly PhaseLike[],
  deadline: string,
  today: string,
  nowMs: number,
): RunwayModel | null {
  // Ordered here so the caller cannot hand this the array in pull order and
  // get a ribbon whose entrance animation staggers backwards.
  const ordered = orderPhases(phases);
  const dated = ordered
    .map((p) => ({ phase: p, start: dayMs(p.start), end: dayMs(p.end) }))
    .filter((x): x is { phase: PhaseLike; start: number; end: number } => x.start !== null && x.end !== null);

  const undated = ordered.length - dated.length;
  if (dated.length === 0) return null;

  const deadlineMs = dayMs(deadline);
  const min = Math.min(...dated.map((x) => x.start));
  const max = Math.max(...dated.map((x) => x.end), ...(deadlineMs === null ? [] : [deadlineMs]));
  // At least a day of span, or a single one-day phase divides by zero and
  // every position comes out `Infinity`.
  const span = Math.max(86400000, max - min);
  const pos = (t: number) => ((t - min) / span) * 100;

  const nowPct = pos(nowMs);

  return {
    undated,
    from: shortMonth(dated[0]!.phase.start),
    to: shortMonth(deadline || dated[dated.length - 1]!.phase.end),
    // `null` when now is off the axis, which is the difference between "the
    // runway has not started" and "today is at 0%".
    todayPct: nowPct < 0 || nowPct > 100 ? null : clamp(nowPct),
    segments: dated.map(({ phase, start, end }) => {
      const total = phase.tasks.length;
      const done = phase.tasks.filter((t) => t.done).length;
      return {
        id: phase.id,
        title: phase.title,
        left: clamp(pos(start)),
        // A floor of 6%, or a two-week phase on a two-year axis is 1% wide and
        // its label is unreadable — and unreachable by a finger.
        width: Math.max(6, clamp(pos(end)) - clamp(pos(start))),
        pct: total ? (done / total) * 100 : 0,
        done,
        total,
        status: phase.end < today ? "past" : phase.start > today ? "future" : "current",
      };
    }),
  };
}
