import { create } from "zustand";
import { useData } from "./data";
import { study } from "./study";

export type TimerMode = "focus" | "short" | "long";

interface TimerState {
  mode: TimerMode;
  secondsLeft: number;
  running: boolean;
  completedFocus: number;
  plan: string | null;
  topic: string;
  notes: string;
  tags: string;
  justCompleted: TimerMode | null; // transient flag for UI flash
  start: () => void;
  pause: () => void;
  reset: () => void;
  setMode: (m: TimerMode) => void;
  addMinutes: (n: number) => void;
  setField: (patch: Partial<Pick<TimerState, "plan" | "topic" | "notes" | "tags">>) => void;
  logNow: () => void; // log elapsed focus time as a session immediately
}

/** Minutes a `logNow` should record, or null when it must record nothing.
 *
 * The bug this replaced measured `focusLength - secondsLeft` regardless of
 * mode, so four minutes into a five-minute break it computed 25 − 4 = 21
 * minutes of study and wrote them to the log as fact. Invented minutes are
 * indistinguishable from real ones once they are in the record, permanently.
 *
 * Null rather than 0 outside focus: "I studied for 0 minutes" is a record,
 * "you were on a break" is the truth, and the caller should write neither.
 *
 * Exported so its test binds to this function instead of restating it.
 */
export function minutesLogged(
  mode: string,
  secondsLeft: number,
  modeSeconds: number,
): number | null {
  if (mode !== "focus") return null;
  return Math.max(1, Math.round((modeSeconds - secondsLeft) / 60));
}

const settings = () =>
  useData.getState().data?.academics.studyPlanner.pomodoroSettings ?? {
    focus: 25,
    shortBreak: 5,
    longBreak: 15,
    rounds: 4,
  };

const durationFor = (m: TimerMode): number => {
  const s = settings();
  if (m === "focus") return s.focus * 60;
  if (m === "short") return s.shortBreak * 60;
  return s.longBreak * 60;
};

let interval: ReturnType<typeof setInterval> | null = null;

export const useTimer = create<TimerState>((set, get) => {
  const ensureTicking = () => {
    if (interval) return;
    interval = setInterval(() => {
      const s = get();
      if (!s.running) return;
      if (s.secondsLeft > 1) {
        set({ secondsLeft: s.secondsLeft - 1 });
      } else {
        complete();
      }
    }, 1000);
  };

  const complete = () => {
    const s = get();
    if (s.mode === "focus") {
      const mins = Math.max(1, Math.round(durationFor("focus") / 60));
      const tags = s.tags
        .split(/\s+/)
        .filter((t) => t.startsWith("#"));
      study.addSession({
        duration: mins,
        plan: s.plan,
        topic: s.topic || "Focus session",
        notes: s.notes || undefined,
        tags: tags.length ? tags : undefined,
      });
      const completed = s.completedFocus + 1;
      const isLong = completed % settings().rounds === 0;
      const next: TimerMode = isLong ? "long" : "short";
      set({
        completedFocus: completed,
        mode: next,
        secondsLeft: durationFor(next),
        running: false,
        notes: "",
        tags: "",
        justCompleted: "focus",
      });
    } else {
      set({
        mode: "focus",
        secondsLeft: durationFor("focus"),
        running: false,
        justCompleted: s.mode,
      });
    }
    setTimeout(() => set({ justCompleted: null }), 1200);
  };

  return {
    mode: "focus",
    secondsLeft: 25 * 60,
    running: false,
    completedFocus: 0,
    plan: null,
    topic: "",
    notes: "",
    tags: "",
    justCompleted: null,
    start: () => {
      ensureTicking();
      set({ running: true });
    },
    pause: () => set({ running: false }),
    reset: () => set({ secondsLeft: durationFor(get().mode), running: false }),
    setMode: (mode) => set({ mode, secondsLeft: durationFor(mode), running: false }),
    addMinutes: (n) => set({ secondsLeft: get().secondsLeft + n * 60 }),
    setField: (patch) => set(patch),
    logNow: () => {
      const s = get();
      // Against the CURRENT mode's duration, not always focus's.
      //
      // `durationFor("focus") - secondsLeft` during a 5-minute break computes
      // 25 − 4 = 21 minutes of study that nobody did, and writes it to the
      // session log as fact. A study log you cannot trust is worse than no
      // study log: it is the same number of minutes, permanently, and there is
      // nothing in the record marking which ones were invented.
      //
      // Refused rather than logged as zero, for the same reason. "I studied
      // for 0 minutes" is a record; "you were on a break" is the truth.
      const elapsed = minutesLogged(s.mode, s.secondsLeft, durationFor(s.mode));
      if (elapsed === null) return;
      const tags = s.tags.split(/\s+/).filter((t) => t.startsWith("#"));
      study.addSession({
        duration: elapsed,
        plan: s.plan,
        topic: s.topic || "Focus session",
        notes: s.notes || undefined,
        tags: tags.length ? tags : undefined,
      });
      set({ secondsLeft: durationFor("focus"), running: false, notes: "", tags: "" });
    },
  };
});
