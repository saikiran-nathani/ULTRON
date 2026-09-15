import { useData } from "./data";
import { todayStr } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);

const MAX_BACKFILL_DAYS = 14;

/** Add `n` days to a YYYY-MM-DD string via UTC-anchored math (pure calendar-day
 *  arithmetic on the string itself — DST-safe, independent of local "today"). */
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days still needing a check-in: from lastCompletedDate+1 .. today (capped). */
export function getPendingDays(d: NexusData): string[] {
  const today = todayStr();
  const last = d.routine.lastCompletedDate;

  let cursor = last ? addDays(last, 1) : today; // first run: just today
  const earliest = addDays(today, -(MAX_BACKFILL_DAYS - 1));
  if (cursor < earliest) cursor = earliest;

  const days: string[] = [];
  while (cursor <= today) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/** Should the routine surface right now? */
export function isRoutineDue(d: NexusData): boolean {
  const pending = getPendingDays(d);
  if (pending.length === 0) return false;
  const today = todayStr();
  if (pending.some((x) => x < today)) return true; // backlog → due regardless of time
  // only today pending → due once past the configured time
  //
  // Bound with fallbacks rather than destructured: `noUncheckedIndexedAccess`
  // types both halves as `number | undefined`, and a `time` that does not
  // parse would otherwise compare against NaN — which is always false, so the
  // nightly check-in would simply never become due and nothing would say why.
  // The fallback is the documented default, 23:30.
  const clock = (d.routine.time || "23:30").split(":").map(Number);
  const hh = Number.isFinite(clock[0]) ? (clock[0] as number) : 23;
  const mm = Number.isFinite(clock[1]) ? (clock[1] as number) : 30;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm;
}

export const routine = {
  complete: (date: string) =>
    update((d) => {
      if (!d.routine.lastCompletedDate || date > d.routine.lastCompletedDate) {
        d.routine.lastCompletedDate = date;
      }
    }),
  setTime: (time: string) => update((d) => void (d.routine.time = time)),
};
