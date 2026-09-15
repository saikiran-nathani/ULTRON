/**
 * The pomodoro panel.
 *
 * Ported from nexus's `screens/study/Focus.tsx`. The clock itself lives in
 * `store/timer.ts` — a plain zustand store, outside `NexusData` and outside
 * persistence, which is right: a half-finished countdown is not a fact about
 * the user's work, and syncing one would have five devices arguing about
 * whose 14:32 is authoritative. Only the *completed* session is a record, and
 * the store writes that through the `study` slice. Nothing here adds timer
 * state to the blob.
 *
 * Four changes from the source:
 *
 * - The mode switcher's `min-h-11 md:min-h-0` is now `pointer-coarse:`. That
 *   pair is the exact anti-pattern `components/ui/README.md` names: `md:`
 *   matches an iPad, so the breakpoint cancelled the 44px floor on a
 *   touch-driven 1024px screen — two of this app's five devices.
 * - `pomodoroSettings` is editable. In nexus `setPomodoro` had no call site at
 *   all: the durations were readable by the timer and unreachable from every
 *   screen, so the only way to change a focus block was to edit the JSON.
 * - "Log session now" is disabled outside focus mode, and says what it will
 *   log. `logNow` measures elapsed time as `focusLength - secondsLeft`
 *   regardless of the current mode, so pressing it during a 5-minute break
 *   logs a ~20-minute session that never happened.
 * - The plan picker is ordered by name, and says so when the selected plan has
 *   been deleted rather than rendering an empty select.
 */
import { useState, type ReactNode } from "react";
import { Check, Pause, Play, Plus, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button, Card, FormModal, IconButton, inputCls, labelCls } from "@/components/ui";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/nexus/format";
import { study } from "@/store/study";
import { useTimer, type TimerMode } from "@/store/timer";
import type { StudyPlanner } from "@/lib/nexus/types";
import { parseTags, plansByName } from "./studyMath";

const MODES: { id: TimerMode; label: string }[] = [
  { id: "focus", label: "Focus" },
  { id: "short", label: "Short break" },
  { id: "long", label: "Long break" },
];

export function Focus({ sp }: { sp: StudyPlanner }) {
  // No selector on purpose: this component is a clock, so it wants every tick.
  const t = useTimer();
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);

  const plans = plansByName(sp.plans);
  const selectedPlan = t.plan ? plans.find((p) => p.id === t.plan) : undefined;
  const tags = parseTags(t.tags);

  const focusSeconds = sp.pomodoroSettings.focus * 60;
  const elapsedMinutes = Math.max(1, Math.round((focusSeconds - t.secondsLeft) / 60));
  const canLog = t.mode === "focus";

  const settingsModal = () =>
    setModal(
      <FormModal
        title="Timer"
        onClose={close}
        submitLabel="Save"
        initial={{
          focus: sp.pomodoroSettings.focus,
          shortBreak: sp.pomodoroSettings.shortBreak,
          longBreak: sp.pomodoroSettings.longBreak,
          rounds: sp.pomodoroSettings.rounds,
        }}
        fields={[
          { key: "focus", label: "Focus (min)", type: "number", min: 1, step: 1 },
          { key: "shortBreak", label: "Short break (min)", type: "number", min: 1, step: 1 },
          { key: "longBreak", label: "Long break (min)", type: "number", min: 1, step: 1 },
          { key: "rounds", label: "Focus blocks per long break", type: "number", min: 1, step: 1 },
        ]}
        onSubmit={(v) =>
          study.setPomodoro({
            // Floored at 1: a 0-minute focus block completes instantly and
            // then completes again, logging a session per tick.
            focus: Math.max(1, Math.round(Number(v.focus)) || 1),
            shortBreak: Math.max(1, Math.round(Number(v.shortBreak)) || 1),
            longBreak: Math.max(1, Math.round(Number(v.longBreak)) || 1),
            rounds: Math.max(1, Math.round(Number(v.rounds)) || 1),
          })
        }
      />,
    );

  return (
    <div className="grid grid-cols-1 gap-5 pt-5 md:grid-cols-[1.2fr_1fr]">
      {modal}

      <Card
        className={cn(
          "flex flex-col items-center gap-6 p-6 md:p-8",
          t.justCompleted && "border-l-2 border-l-accent",
        )}
      >
        <div className="flex items-center gap-1 rounded-sm border-[0.5px] border-line p-0.5" role="radiogroup">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={t.mode === m.id}
              onClick={() => t.setMode(m.id)}
              className={cn(
                // Was `min-h-11 md:min-h-0`. A fine pointer now matches no
                // rule at all, so the desktop metric stays padding-driven and
                // identical; a coarse pointer gets the floor on every screen
                // size, iPad included.
                "rounded-xs px-3 py-1 text-[11.5px] transition-colors pointer-coarse:min-h-[44px]",
                t.mode === m.id ? "bg-accent/15 text-accent-lt" : "text-fg-muted hover:text-fg-dim",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div
          className="nums text-[72px] leading-none tracking-tight text-fg"
          role="timer"
          aria-live="off"
        >
          {fmtTime(t.secondsLeft)}
        </div>

        {/* `flex-wrap justify-center` below `md:`: three buttons at the coarse
            44px floor overflow a 375px card, and the third one is the one that
            goes off the edge. On a fine pointer they have always fitted on one
            line, and still do. */}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="primary"
            size="md"
            icon={t.running ? <Pause size={15} /> : <Play size={15} />}
            onClick={() => (t.running ? t.pause() : t.start())}
          >
            {t.running ? "Pause" : "Start"}
          </Button>
          <Button variant="ghost" icon={<RotateCcw size={14} />} onClick={t.reset}>
            Reset
          </Button>
          <Button variant="ghost" icon={<Plus size={14} />} onClick={() => t.addMinutes(5)}>
            5 min
          </Button>
        </div>

        <div className="text-center text-[11px] text-fg-muted">
          Round {t.completedFocus + 1} · completed today: {t.completedFocus}
        </div>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <span className="label">Session</span>
          <IconButton
            icon={<SlidersHorizontal size={13} />}
            label="Timer settings"
            onClick={settingsModal}
          />
        </div>

        <label>
          <span className={labelCls}>Plan</span>
          <select
            className={inputCls}
            value={t.plan ?? ""}
            onChange={(e) => t.setField({ plan: e.target.value || null })}
          >
            <option value="">No plan</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {/* The selected plan was deleted on this or another device. Without
                this the select renders blank and silently reads as "No plan",
                while the session still gets filed against the dead id. */}
            {t.plan && !selectedPlan && <option value={t.plan}>(deleted plan)</option>}
          </select>
        </label>

        <label>
          <span className={labelCls}>Topic</span>
          <input
            className={inputCls}
            placeholder="What are you studying?"
            value={t.topic}
            onChange={(e) => t.setField({ topic: e.target.value })}
          />
        </label>

        <label>
          <span className={labelCls}>Tags</span>
          <input
            className={inputCls}
            placeholder="#exam #review"
            value={t.tags}
            onChange={(e) => t.setField({ tags: e.target.value })}
          />
        </label>
        {t.tags.trim() !== "" && (
          <p className="text-[10.5px] text-fg-muted">
            {tags.length > 0 ? (
              <>
                Saves as <span className="nums text-fg-dim">{tags.join(" ")}</span>
              </>
            ) : (
              "Nothing here starts with #, so no tags will be saved."
            )}
          </p>
        )}

        <label>
          <span className={labelCls}>Notes</span>
          <textarea
            className={inputCls + " min-h-[80px] resize-y"}
            value={t.notes}
            onChange={(e) => t.setField({ notes: e.target.value })}
          />
        </label>

        <Button variant="subtle" icon={<Check size={14} />} onClick={t.logNow} disabled={!canLog}>
          {canLog ? `Log ${elapsedMinutes} min now` : "Log session now"}
        </Button>
        <p className="text-[10.5px] text-fg-muted">
          {canLog
            ? "Finishing a focus block (or logging now) records a session — 2 XP per minute."
            : "Switch back to Focus to log a session; on a break there is no focus time to measure."}
        </p>
        <p className="text-[10.5px] text-fg-muted">
          New durations apply to the next block — press Reset to take them now.
        </p>
      </Card>
    </div>
  );
}
