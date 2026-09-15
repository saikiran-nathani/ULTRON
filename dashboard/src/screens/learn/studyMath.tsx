/**
 * The Self-learning screen's folds, its calendar arithmetic, and its ordering.
 * No React in this file.
 *
 * `.tsx` rather than `.ts` only because this directory's brief allows
 * `src/screens/learn/*.tsx` and nothing else — the same compromise
 * `components/ui/index.tsx` documents.
 *
 * Ported from nexus's `lib/study.ts`, with four deliberate changes:
 *
 * 1. **"Today" is a parameter.** nexus read `Date.now()` inside every one of
 *    these, which makes a streak untestable and makes it wrong on exactly one
 *    day a year (a DST boundary crossed with `Date.now() - 86400000`). Every
 *    function here takes `today` with a default, so the screen never passes it
 *    and a test always does.
 * 2. **Day gaps are computed on day numbers, not on `Date` objects.** nexus
 *    mixed `new Date("YYYY-MM-DD")` (UTC midnight) with
 *    `toDayStr(new Date(...))` (local midnight) inside one comparison. The two
 *    agree for most of the year and disagree by a day in a negative-offset
 *    timezone after ~8pm, which is when a streak is most likely to be checked.
 * 3. **XP is folded, never read from a counter.** `StudyPlanner.xp` was
 *    deleted from the schema for the reason `lib/nexus/types.ts` spells out:
 *    last-writer-wins on a counter loses increments, so a device's total ends
 *    up disagreeing with the session list it is meant to summarise.
 * 4. **Level colours are tokens.** nexus's `getXPLevel` returned six hex
 *    literals. They are mapped onto this theme's slots here so the palette
 *    stays a one-file change.
 *
 * And the ordering, which is the port's main hazard: nexus rendered
 * `sp.plans`, `plan.modules` and `module.topics` in **array order**. Per-record
 * sync does not carry array position — records arrive one at a time in the
 * server's `seq` order and the arrays are rebuilt in ascending id order — so
 * array order is a different list on each of the five devices. Every list is
 * ordered by a field here, and the comparators are exported so a test can pin
 * them.
 */
import { todayStr } from "@/lib/nexus/format";
import type { StudyModule, StudyPlan, StudySession, Topic } from "@/lib/nexus/types";

/* ──────────────────────── Calendar-day arithmetic ────────────────────── */

/**
 * "YYYY-MM-DD" → whole days since the epoch, or `null` if it is not a date.
 *
 * Built from the numbers rather than by parsing, so it is one fixed calendar
 * with no timezone in it at all. Differences between two of these are exact
 * whole days across DST, which `(a - b) / 86400000` on two `Date`s is not.
 */
export function dayNumber(day: string): number | null {
  const parts = day.slice(0, 10).split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return null;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * The calendar day `n` days before `day`, as "YYYY-MM-DD".
 *
 * The inverse of `dayNumber`, read back through the same fixed calendar.
 * Deliberately **not** `toDayStr(new Date(Date.now() - n * 86400000))`, which
 * is what nexus used: that subtracts 24 real hours and then reads local
 * calendar fields off the result, so on the two DST boundaries it either
 * repeats a day or skips one — and a heatmap with a duplicated column is a
 * heatmap silently misattributing somebody's study minutes.
 */
export function shiftDay(day: string, n: number): string {
  const base = dayNumber(day);
  if (base === null) return day;
  const d = new Date((base - n) * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** The day part of a session's ISO timestamp. */
export const sessionDay = (s: StudySession): string => (s.date || "").slice(0, 10);

/* ─────────────────────────────── Folds ───────────────────────────────── */

/**
 * Total XP, folded over the sessions that earned it.
 *
 * Replaces the deleted `StudyPlanner.xp`. A fold cannot drift from the list it
 * summarises and cannot lose an increment to a concurrent write; a stored
 * counter does both.
 */
export const totalXp = (sessions: StudySession[]): number =>
  sessions.reduce((sum, s) => sum + (Number(s.xp) || 0), 0);

/** The most recent session's timestamp, or null when there are none. */
export function lastStudyDate(sessions: StudySession[]): string | null {
  let latest: string | null = null;
  for (const s of sessions) if (s.date && (latest === null || s.date > latest)) latest = s.date;
  return latest;
}

/**
 * Consecutive study-day streak, with a single one-day freeze.
 *
 * Behaviour is nexus's: the run must reach today or yesterday to count at all
 * (or the day before yesterday, if yesterday was the frozen day), and one
 * two-day gap is bridged when the missing day is the frozen one.
 */
export function calculateStreak(
  sessions: StudySession[],
  streakFreezeDate?: string,
  today: string = todayStr(),
): number {
  const days = [...new Set(sessions.map(sessionDay).filter(Boolean))]
    .map(dayNumber)
    .filter((n): n is number => n !== null)
    .sort((a, b) => b - a);
  const head = days[0];
  if (head === undefined) return 0;

  const t = dayNumber(today);
  if (t === null) return 0;
  const freeze = streakFreezeDate ? dayNumber(streakFreezeDate) : null;

  if (head !== t && head !== t - 1) {
    // Not current. A freeze taken yesterday buys one more day of grace, and
    // only if the run actually reaches back that far.
    if (freeze !== null && freeze === t - 1) {
      if (head !== t - 2) return 0;
    } else {
      return 0;
    }
  }

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const curr = days[i];
    if (prev === undefined || curr === undefined) break;
    const gap = prev - curr;
    if (gap === 1) {
      streak++;
    } else if (gap === 2 && freeze !== null && freeze === curr + 1) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/** Minutes studied across the last `days` calendar days, today included. */
export function getRollingWeekMinutes(
  sessions: StudySession[],
  days = 7,
  today: string = todayStr(),
): number {
  const t = dayNumber(today);
  if (t === null) return 0;
  const cut = t - (days - 1);
  return sessions.reduce((sum, s) => {
    const n = dayNumber(sessionDay(s));
    if (n === null || n < cut || n > t) return sum;
    return sum + (Number(s.duration) || 0);
  }, 0);
}

export interface HeatDay {
  date: string;
  mins: number;
}

/**
 * The last `days` calendar days, oldest first, each with its minutes.
 *
 * One function instead of nexus's `getStudyHeatmap` + the component's own
 * re-derivation loop, which built the same day list twice — once forwards and
 * once backwards — and had to agree with itself about the range. Anything
 * outside the window is dropped rather than folded into the edge day.
 */
export function heatmapDays(
  sessions: StudySession[],
  days = 91,
  today: string = todayStr(),
): HeatDay[] {
  const t = dayNumber(today);
  if (t === null) return [];
  const mins = new Map<number, number>();
  for (const s of sessions) {
    const n = dayNumber(sessionDay(s));
    if (n === null || n > t || n <= t - days) continue;
    mins.set(n, (mins.get(n) ?? 0) + (Number(s.duration) || 0));
  }
  const out: HeatDay[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ date: shiftDay(today, i), mins: mins.get(t - i) ?? 0 });
  }
  return out;
}

export interface XPLevel {
  level: number;
  title: string;
  min: number;
  next: number | null;
  color: string;
}

/**
 * XP → level. The six thresholds are nexus's; the six colours are this
 * theme's tokens rather than nexus's hex literals.
 */
export function getXPLevel(xp: number): XPLevel {
  if (xp >= 2000) return { level: 6, title: "Grandmaster", min: 2000, next: null, color: "var(--color-warn)" };
  if (xp >= 1000) return { level: 5, title: "Master", min: 1000, next: 2000, color: "var(--color-accent-lt)" };
  if (xp >= 500) return { level: 4, title: "Expert", min: 500, next: 1000, color: "var(--color-info)" };
  if (xp >= 200) return { level: 3, title: "Scholar", min: 200, next: 500, color: "var(--color-good)" };
  if (xp >= 50) return { level: 2, title: "Learner", min: 50, next: 200, color: "var(--color-accent)" };
  return { level: 1, title: "Novice", min: 0, next: 50, color: "var(--color-fg-muted)" };
}

/** How far through a level `xp` is, 0–100. */
export function levelPct(xp: number, lvl: XPLevel): number {
  if (lvl.next === null) return 100;
  const span = lvl.next - lvl.min;
  if (span <= 0) return 100;
  return ((xp - lvl.min) / span) * 100;
}

export interface PlanProgress {
  done: number;
  total: number;
  pct: number;
}

/** Topic completion across a plan's modules. */
export function planProgress(plan: StudyPlan): PlanProgress {
  let done = 0;
  let total = 0;
  for (const m of plan.modules) {
    for (const t of m.topics) {
      total++;
      if (t.done) done++;
    }
  }
  return { done, total, pct: total > 0 ? (done / total) * 100 : 0 };
}

/* ────────────────────────────── Ordering ─────────────────────────────── */

/**
 * Plans by deadline, soonest first; undated plans last.
 *
 * `id` is the final tiebreak on every comparator here. Without it two records
 * that tie on every visible field can swap places between renders on one
 * device and between devices on the same data — the same instability that
 * ordering by a field was meant to remove.
 */
export function sortedPlans(plans: StudyPlan[]): StudyPlan[] {
  return [...plans].sort((a, b) => {
    const ad = a.deadline || "";
    const bd = b.deadline || "";
    if (!ad !== !bd) return ad ? -1 : 1;
    if (ad !== bd) return ad.localeCompare(bd);
    const name = a.name.localeCompare(b.name);
    if (name !== 0) return name;
    return a.id.localeCompare(b.id);
  });
}

/** Plans by name — the order the Focus tab's plan picker needs. */
export function plansByName(plans: StudyPlan[]): StudyPlan[] {
  return [...plans].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Modules by name.
 *
 * Worth flagging rather than burying: `StudyModule` has **no order field** —
 * `id`, `name`, `topics` and nothing else. nexus showed modules in insertion
 * order, which is the one thing per-record sync cannot reproduce, and there is
 * no field on the record that means "module 3 of 8". `ProjectTask` got a
 * fractional `sort` key for exactly this problem; `StudyModule` did not, and
 * adding one is a schema change outside this screen's remit. So the order is
 * alphabetical: stable across devices, and wrong only in that "Module 10"
 * sorts before "Module 2".
 */
export function sortedModules(modules: StudyModule[]): StudyModule[] {
  return [...modules].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Topics by name. Same missing-order-field caveat as `sortedModules`. */
export function sortedTopics(topics: Topic[]): Topic[] {
  return [...topics].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Sessions newest first. nexus sorted by date already; the `id` tiebreak is new. */
export function sortedSessions(sessions: StudySession[]): StudySession[] {
  return [...sessions].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/* ─────────────────────────────── Parsing ─────────────────────────────── */

/**
 * `"#exam #review"` → `["#exam", "#review"]`.
 *
 * Character-for-character `store/timer.ts`'s own split, which is the one that
 * actually runs when a focus block completes. Exported so the tag preview
 * under the input cannot disagree with what gets stored — a preview that lies
 * about which words counted is worse than no preview. Which also means it
 * inherits the store's quirk: a lone "#" is a tag. Tightening it here would
 * make the preview right and wrong at the same time.
 */
export const parseTags = (raw: string): string[] =>
  raw.split(/\s+/).filter((t) => t.startsWith("#"));
