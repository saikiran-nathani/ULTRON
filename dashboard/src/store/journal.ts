import { useData } from "./data";
import { uid, todayStr, toDayStr } from "@/lib/nexus/format";
import { completionId } from "@/lib/nexus/types";
import type { NexusData, JournalEntry, ReadingItem, Fragment, FragmentType } from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);
const find = (d: NexusData, id: string) => d.journal.fragments.find((f) => f.id === id);
const touch = (f: Fragment) => (f.updatedAt = new Date().toISOString());

export const journal = {
  addEntry: (e: { date: string; content: string; mood: number }) =>
    update((d) => void d.journal.entries.unshift({ id: uid(), ...e })),
  editEntry: (id: string, patch: Partial<JournalEntry>) =>
    update((d) => {
      const e = d.journal.entries.find((e) => e.id === id);
      if (e) Object.assign(e, patch);
    }),
  delEntry: (id: string) =>
    update((d) => {
      d.journal.entries = d.journal.entries.filter((e) => e.id !== id);
    }),

  addHabit: (h: { name: string; color: string }) =>
    update((d) => void d.journal.habits.push({ id: uid(), ...h })),
  delHabit: (id: string) =>
    update((d) => {
      d.journal.habits = d.journal.habits.filter((h) => h.id !== id);
      // Sweep the ticks too. They are their own records now, so deleting the
      // habit no longer deletes them implicitly -- and orphaned completions
      // would be invisible in the UI while still syncing forever.
      d.journal.habitCompletions = d.journal.habitCompletions.filter(
        (c) => c.habitId !== id,
      );
    }),
  /**
   * Tick or untick one habit on one day: one record added or removed.
   *
   * The previous version assigned a whole new completions array, which is
   * unmergeable -- two devices ticking different days in one offline window
   * meant one array overwrote the other and the loser's days vanished. This
   * touches exactly the record the user touched.
   */
  toggleHabit: (id: string, date: string) =>
    update((d) => {
      if (!d.journal.habits.some((h) => h.id === id)) return;
      const key = completionId(id, date);
      const at = d.journal.habitCompletions.findIndex((c) => c.id === key);
      if (at >= 0) d.journal.habitCompletions.splice(at, 1);
      else d.journal.habitCompletions.push({ id: key, habitId: id, date });
    }),

  addReading: (r: Omit<ReadingItem, "id">) =>
    update((d) => void d.journal.readingList.push({ id: uid(), ...r })),
  editReading: (id: string, patch: Partial<ReadingItem>) =>
    update((d) => {
      const r = d.journal.readingList.find((r) => r.id === id);
      if (r) Object.assign(r, patch);
    }),
  delReading: (id: string) =>
    update((d) => {
      d.journal.readingList = d.journal.readingList.filter((r) => r.id !== id);
    }),

  /* ── Categorized journal (fragments) ── */
  addFragment: (f: { category: string; fragment: string; body?: string; type: FragmentType }) =>
    update((d) => {
      const now = new Date().toISOString();
      d.journal.fragments.unshift({
        id: uid(),
        date: todayStr(),
        category: f.category,
        fragment: f.fragment,
        ...(f.body ? { body: f.body } : {}),
        type: f.type,
        recurrence: 1,
        promoted: false,
        createdAt: now,
        updatedAt: now,
      });
    }),
  updateFragment: (id: string, patch: Partial<Pick<Fragment, "fragment" | "body" | "type">>) =>
    update((d) => {
      const f = find(d, id);
      if (f) {
        Object.assign(f, patch);
        touch(f);
      }
    }),
  recurFragment: (id: string) =>
    update((d) => {
      const f = find(d, id);
      if (f) {
        f.recurrence += 1;
        touch(f);
      }
    }),
  promoteFragment: (id: string) =>
    update((d) => {
      const f = find(d, id);
      if (f) {
        f.promoted = true;
        touch(f);
      }
    }),
  delFragment: (id: string) =>
    update((d) => {
      d.journal.fragments = d.journal.fragments.filter((f) => f.id !== id);
    }),
};

/** Consecutive-day streak for a habit, ending today (or yesterday). */
export function habitStreak(completions: string[]): number {
  const set = new Set(completions);
  let streak = 0;
  const d = new Date();
  // allow today missing (count from yesterday) like a soft streak
  if (!set.has(toDayStr(d))) d.setDate(d.getDate() - 1);
  while (set.has(toDayStr(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** The dates one habit was ticked on. */
export function datesFor(
  completions: { habitId: string; date: string }[],
  habitId: string,
): string[] {
  return completions.filter((c) => c.habitId === habitId).map((c) => c.date);
}

export function useJournal() {
  const j = useData((s) => s.data!.journal);
  return { journal: j, ...journal };
}
