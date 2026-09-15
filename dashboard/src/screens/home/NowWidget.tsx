/**
 * The timer, and whatever stopwatch is running — "what do I have open right
 * now" in its most literal form.
 *
 * Both pass the test trivially: a countdown at 12:04 and a stopwatch that has
 * been on a project for 23 minutes are false a minute from now, let alone next
 * week. What is deliberately *not* here is the total: minutes logged this week,
 * the XP fold, the study streak. Those are accumulated and they belong in the
 * vault; the only number this card shows about the past is the round counter,
 * which lives in zustand rather than the blob and resets with the tab.
 *
 * The stopwatch row renders only while something is being tracked. An empty
 * "nothing running" row would be a widget reporting the absence of an event,
 * which is the report-shaped thing this screen is supposed to avoid.
 */
import { Pause, Play, RotateCcw, Save, Square, Timer } from "lucide-react";
import { Button, Card, CardHead, Chip, InlineEdit, ProgressRing, SegmentedControl } from "@/components/ui";
import { fmtDuration, fmtTime } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";
import { useStopwatch } from "@/store/stopwatch";
import { useTimer, type TimerMode } from "@/store/timer";
import { elapsedPct, stopwatchMinutes } from "./selectors";

const MODES: { id: TimerMode; label: string }[] = [
  { id: "focus", label: "Focus" },
  { id: "short", label: "Short" },
  { id: "long", label: "Long" },
];

/** Seconds in a mode, from the same settings the timer itself reads. */
function durationOf(data: NexusData, mode: TimerMode): number {
  const s = data.academics.studyPlanner.pomodoroSettings;
  if (mode === "focus") return s.focus * 60;
  if (mode === "short") return s.shortBreak * 60;
  return s.longBreak * 60;
}

export function NowWidget({ data }: { data: NexusData }) {
  const timer = useTimer();
  const watch = useStopwatch();

  const total = durationOf(data, timer.mode);
  const pct = elapsedPct(total, timer.secondsLeft);
  const rounds = data.academics.studyPlanner.pomodoroSettings.rounds;
  const spent = Math.max(0, Math.round((total - timer.secondsLeft) / 60));

  const tracked = watch.runningId
    ? data.projects.find((p) => p.id === watch.runningId)
    : undefined;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <CardHead
        label="right now"
        right={
          timer.justCompleted ? (
            <Chip color="var(--color-good)" dot>
              logged
            </Chip>
          ) : timer.running ? (
            <Chip color="var(--color-accent)" dot>
              running
            </Chip>
          ) : undefined
        }
      />

      <div className="flex items-center gap-5">
        <ProgressRing
          value={pct}
          size={92}
          stroke={6}
          color={timer.mode === "focus" ? "var(--color-accent)" : "var(--color-good)"}
        >
          <span className="nums text-[20px] font-medium text-fg">{fmtTime(timer.secondsLeft)}</span>
        </ProgressRing>

        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <SegmentedControl
            options={MODES}
            value={timer.mode}
            onChange={(id) => timer.setMode(id as TimerMode)}
          />
          <div className="min-w-0 text-[12px] text-fg-dim">
            <InlineEdit
              value={timer.topic}
              onCommit={(topic) => timer.setField({ topic })}
              placeholder="What is this session for?"
              className="text-[12px]"
            />
          </div>
          <div className="label">
            {/* Position in the cycle, not a total. It lives in zustand, so it
                is gone on reload — which is the property that keeps it off the
                vault's side of the line. */}
            round {(timer.completedFocus % Math.max(1, rounds)) + 1} of {Math.max(1, rounds)} this
            sitting
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {timer.running ? (
          <Button
            variant="subtle"
            onClick={timer.pause}
            icon={<Pause size={13} strokeWidth={1.8} aria-hidden />}
          >
            Pause
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={timer.start}
            icon={<Play size={13} strokeWidth={1.8} aria-hidden />}
          >
            Start
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={timer.reset}
          icon={<RotateCcw size={13} strokeWidth={1.8} aria-hidden />}
        >
          Reset
        </Button>
        {timer.mode === "focus" && spent > 0 && (
          // The partial session is the one most likely to be lost: stopping a
          // focus block early and navigating away throws the elapsed time out.
          <Button
            variant="ghost"
            onClick={timer.logNow}
            icon={<Save size={13} strokeWidth={1.8} aria-hidden />}
          >
            Log {fmtDuration(spent)}
          </Button>
        )}
      </div>

      {watch.runningId && (
        <div className="flex items-center gap-3 rounded-sm border-[0.5px] border-line bg-bg/60 px-3 py-2.5">
          <Timer size={14} strokeWidth={1.8} className="shrink-0 text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] text-fg">
              {tracked?.name ?? "A project that is no longer here"}
            </div>
            <div className="nums text-[11px] text-fg-muted">
              {fmtDuration(stopwatchMinutes(watch.startedAt, watch.now))} tracked
            </div>
          </div>
          <Button
            size="sm"
            variant="subtle"
            onClick={watch.stop}
            icon={<Square size={11} strokeWidth={2} aria-hidden />}
          >
            Stop
          </Button>
        </div>
      )}
    </Card>
  );
}
