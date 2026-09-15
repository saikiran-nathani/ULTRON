import { useData } from "./data";
import { uid, todayStr } from "@/lib/nexus/format";
import type { NexusData, PomodoroSettings } from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);
const sp = (d: NexusData) => d.academics.studyPlanner;

export const study = {
  /* Plans */
  addPlan: (p: { name: string; course: string; deadline: string }) =>
    update((d) => void sp(d).plans.push({ id: uid(), modules: [], ...p })),
  editPlan: (id: string, patch: Partial<{ name: string; course: string; deadline: string }>) =>
    update((d) => {
      const p = sp(d).plans.find((p) => p.id === id);
      if (p) Object.assign(p, patch);
    }),
  delPlan: (id: string) =>
    update((d) => {
      sp(d).plans = sp(d).plans.filter((p) => p.id !== id);
    }),

  /* Modules */
  addModule: (planId: string, name: string) =>
    update((d) => {
      const p = sp(d).plans.find((p) => p.id === planId);
      if (p) p.modules.push({ id: uid(), name, topics: [] });
    }),
  delModule: (planId: string, modId: string) =>
    update((d) => {
      const p = sp(d).plans.find((p) => p.id === planId);
      if (p) p.modules = p.modules.filter((m) => m.id !== modId);
    }),

  /* Topics */
  addTopic: (planId: string, modId: string, name: string) =>
    update((d) => {
      const m = sp(d).plans.find((p) => p.id === planId)?.modules.find((m) => m.id === modId);
      if (m) m.topics.push({ id: uid(), name, done: false, doneAt: null });
    }),
  toggleTopic: (planId: string, modId: string, topicId: string) =>
    update((d) => {
      const t = sp(d)
        .plans.find((p) => p.id === planId)
        ?.modules.find((m) => m.id === modId)
        ?.topics.find((t) => t.id === topicId);
      if (!t) return;
      t.done = !t.done;
      if (t.done) t.doneAt = new Date().toISOString();
    }),
  delTopic: (planId: string, modId: string, topicId: string) =>
    update((d) => {
      const m = sp(d).plans.find((p) => p.id === planId)?.modules.find((m) => m.id === modId);
      if (m) m.topics = m.topics.filter((t) => t.id !== topicId);
    }),

  /* Sessions — 2 XP/min, recompute streak */
  addSession: (s: {
    duration: number;
    plan: string | null;
    topic: string;
    notes?: string;
    tags?: string[];
    date?: string; // optional backdated ISO datetime (Nightly Routine catch-up)
  }) =>
    update((d) => {
      const planner = sp(d);
      const xp = Math.round(s.duration * 2);
      const date = s.date ?? new Date().toISOString();
      planner.sessions.push({
        id: uid(),
        date,
        duration: s.duration,
        plan: s.plan,
        topic: s.topic,
        xp,
        ...(s.notes ? { notes: s.notes } : {}),
        ...(s.tags && s.tags.length ? { tags: s.tags } : {}),
      });
      // No counter to bump. `xp`, `streak` and `lastStudyDate` are folds over
      // `sessions` now — see the note on StudyPlanner in lib/types.ts.
    }),

  delSession: (id: string) =>
    update((d) => {
      const planner = sp(d);
      planner.sessions = planner.sessions.filter((x) => x.id !== id);
      // Deleting a session removes its XP by construction, so the old
      // `Math.max(0, xp - s.xp)` clamp is gone too. That clamp was a tell: it
      // existed because the counter could already disagree with the list.
    }),

  /* Settings */
  setWeeklyGoal: (mins: number) =>
    update((d) => void (sp(d).weeklyGoalMinutes = mins)),
  setPomodoro: (settings: PomodoroSettings) =>
    update((d) => void (sp(d).pomodoroSettings = settings)),
  freezeStreak: () =>
    update((d) => void (sp(d).streakFreezeDate = todayStr())),
};

export function useStudy() {
  const planner = useData((s) => s.data!.academics.studyPlanner);
  return { sp: planner, ...study };
}
