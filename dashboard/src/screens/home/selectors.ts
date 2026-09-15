/**
 * Home's pure selectors — the part of a launcher that can be checked.
 *
 * Every function here answers a question about *right now*, which is the whole
 * boundary the plan draws:
 *
 * > Home answers "what do I have open right now." Live, ephemeral, glanceable.
 * > The vault answers "how is my work going." Accumulated, narrative.
 *
 * So there is no streak here, no total, no rate and no fold over history. The
 * test applied to each one: if its answer would still be true next week, it
 * belongs in the vault. `todayTodos` narrows by date; `habitsToday` is keyed on
 * one day; `elapsedPct` describes a timer that is running this minute.
 *
 * They are also all **ordered by a field**. Per-record sync rebuilds arrays in
 * key order rather than arrival order, so a screen that trusted array position
 * would render a different list on each device with the data fully converged
 * (see the note on `byKey` in `lib/sync/registry.ts`).
 */
import { NAV, TRACKS, type NavItem, type ScreenId } from "@/config/nav";
import { completionId } from "@/lib/nexus/types";
import type { DashboardTodo, Habit, HabitCompletion } from "@/lib/nexus/types";

/** Undated todos sort after every dated one. Beyond any ISO date string. */
const UNDATED = "￿";

/**
 * The todos that are a today problem: overdue, due today, or undated.
 *
 * `keep` holds ids ticked during this visit to the screen. Without it a tap
 * makes the row vanish, which reads as "did that register?" — and there is no
 * `doneAt` on `DashboardTodo`, so "done today" is genuinely not answerable from
 * the model. Session state is the honest place for it: it cannot survive to
 * next week, which is exactly the property this screen needs.
 *
 * A todo due next Friday is excluded. It would still be true next week, so it
 * is not a today question and the track screen owns it.
 */
export function todayTodos(
  todos: DashboardTodo[],
  today: string,
  keep: ReadonlySet<string> = new Set(),
): DashboardTodo[] {
  return todos
    .filter((t) => (!t.done || keep.has(t.id)) && (t.dueDate === null || t.dueDate <= today))
    .sort(
      (a, b) =>
        (a.dueDate ?? UNDATED).localeCompare(b.dueDate ?? UNDATED) ||
        (a.order ?? 0) - (b.order ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

export interface HabitTick {
  habit: Habit;
  done: boolean;
}

/**
 * Every habit with whether it is ticked *today*.
 *
 * The completion id comes from `completionId`, never from a hand-built
 * template. Two devices ticking the same habit on the same day have to mint the
 * same record id or they converge onto two identical ticks, and one extra copy
 * of that string is one chance to get it wrong.
 *
 * What is deliberately absent: the streak. `habitStreak` exists in
 * `@/store/journal` and a streak is accumulated narrative — true next week,
 * and therefore the vault's.
 */
export function habitsToday(
  habits: Habit[],
  completions: HabitCompletion[],
  today: string,
): HabitTick[] {
  const ticked = new Set(completions.map((c) => c.id));
  return [...habits]
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((habit) => ({ habit, done: ticked.has(completionId(habit.id, today)) }));
}

export interface LauncherTile {
  id: ScreenId;
  label: string;
  icon: NavItem["icon"];
  blurb: string;
}

/**
 * What each destination is for — one line, no numbers.
 *
 * A count here ("3 active projects") would be the launcher quietly becoming a
 * report: it would still be true next week, so by the plan's own test it
 * belongs in the vault. A tile says where a door goes and nothing else.
 */
const BLURB: Partial<Record<ScreenId, string>> = {
  courses: "Semesters, assignments, grades",
  projects: "What is being built, and its tasks",
  research: "Experiments, and the runs behind them",
  learn: "Plans, topics, logged sessions",
  career: "Applications, certifications, the roadmap",
};

/**
 * The four tracks, then Career, in the order they feed each other.
 *
 * Built from `NAV` rather than restated, so a renamed screen renames its tile
 * — and an id that leaves `NAV` disappears from the launcher instead of
 * rendering a dead tile. The test asserts the join resolves for every id,
 * which is what makes that safe rather than silent.
 */
export function launcherTiles(): LauncherTile[] {
  const ids: ScreenId[] = [...TRACKS, "career"];
  const tiles: LauncherTile[] = [];
  for (const id of ids) {
    const item = NAV.find((n) => n.id === id);
    if (!item) continue;
    tiles.push({ id, label: item.label, icon: item.icon, blurb: BLURB[id] ?? "" });
  }
  return tiles;
}

/**
 * How far through a countdown, as 0–100.
 *
 * `total <= 0` returns 0 rather than dividing: the pomodoro duration comes from
 * `pomodoroSettings`, which is user-editable and sync-merged, so a zero is
 * reachable — and `NaN` in a ring's `stroke-dashoffset` leaves the previous arc
 * painted, which reads as a timer that is running when it is not.
 */
export function elapsedPct(totalSeconds: number, secondsLeft: number): number {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return 0;
  if (!Number.isFinite(secondsLeft)) return 0;
  const done = ((totalSeconds - secondsLeft) / totalSeconds) * 100;
  return Math.max(0, Math.min(100, done));
}

/**
 * Whole minutes a stopwatch has been running, floored at 0.
 *
 * Floored because a clock that went backwards — a device whose time was
 * corrected while a stopwatch ran — would otherwise render a negative
 * duration, which is worse than reading zero for a moment.
 */
export function stopwatchMinutes(startedAt: number | null, now: number): number {
  if (startedAt === null || !Number.isFinite(startedAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 60000));
}
