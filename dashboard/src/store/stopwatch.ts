import { create } from "zustand";
import { projects } from "./projects";
import { todayStr } from "@/lib/nexus/format";

interface StopwatchState {
  runningId: string | null;
  startedAt: number | null;
  now: number;
  start: (id: string) => void;
  stop: () => void;
}

let iv: ReturnType<typeof setInterval> | null = null;

/** One project stopwatch at a time; on stop, logs a time entry. */
export const useStopwatch = create<StopwatchState>((set, get) => ({
  runningId: null,
  startedAt: null,
  now: Date.now(),
  start: (id) => {
    if (iv) clearInterval(iv);
    set({ runningId: id, startedAt: Date.now(), now: Date.now() });
    iv = setInterval(() => set({ now: Date.now() }), 1000);
  },
  stop: () => {
    const { runningId, startedAt } = get();
    if (runningId && startedAt) {
      const mins = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
      projects.logTime(runningId, { date: todayStr(), duration: mins, description: "Tracked session" });
    }
    if (iv) {
      clearInterval(iv);
      iv = null;
    }
    set({ runningId: null, startedAt: null });
  },
}));
