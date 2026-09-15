/**
 * The runway: every phase on a proportional time axis, with a live playhead.
 *
 * Ported from nexus's `roadmap/TimelineRibbon.tsx`. Read-only — it mutates
 * nothing; tapping a segment scrolls to that phase's card.
 *
 * Touch changes, both required:
 *
 * - The source's segments were 46px tall, which clears 44px only by accident
 *   and not at all once a phase is 6% of a 375px axis. Here the whole track is
 *   taller on a coarse pointer and the segments take a `min-h` floor, so a
 *   short phase is still hittable.
 * - `title={…}` was the only place the task count was written for a segment
 *   too narrow to show it. A tooltip is not a touch affordance, so the count
 *   is also `aria-label`'d, and the card it scrolls to carries the same
 *   numbers.
 */
import { motion } from "framer-motion";
import { CalendarOff } from "lucide-react";
import { CountUp } from "@/components/ui";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { daysFromToday, todayStr } from "@/lib/nexus/format";
import type { RoadmapPhase } from "@/lib/nexus/types";
import { runwayModel } from "./timeline";

export function Runway({
  phases,
  deadline,
  onSelect,
}: {
  phases: readonly RoadmapPhase[];
  deadline: string;
  onSelect: (id: string) => void;
}) {
  const today = todayStr();
  const model = runwayModel(phases, deadline, today, Date.now());
  if (!model) return null;

  const daysLeft = daysFromToday(deadline);

  return (
    <div className="rounded-md border-[0.5px] border-line bg-card/70 p-5 shadow-card backdrop-blur-md">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="label text-accent-dim">The runway</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <CountUp
              value={Math.abs(daysLeft)}
              className="nums text-[26px] leading-none text-accent-lt"
            />
            <span className="text-[11px] text-fg-muted">
              {deadline === ""
                ? "no deadline set"
                : daysLeft > 0
                  ? "days to the real deadline"
                  : daysLeft === 0
                    ? "— the deadline is today"
                    : "days past the deadline"}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="label">Window</div>
          <div className="nums mt-1 text-[11px] text-fg-dim">
            {model.from} → {model.to}
          </div>
        </div>
      </div>

      {/* Taller on touch so a 6%-wide segment is still a 44px target. */}
      <div className="relative h-[74px] pointer-coarse:h-[92px]">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-line" />

        {model.segments.map((s, i) => (
          <motion.button
            key={s.id}
            onClick={() => onSelect(s.id)}
            initial={{ opacity: 0, scaleX: 0 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={{ duration: 0.6, delay: 0.05 * i, ease: EASE }}
            style={{ left: `${s.left}%`, width: `${s.width}%`, transformOrigin: "left center" }}
            className={cn(
              "absolute top-1/2 flex h-[46px] -translate-y-1/2 flex-col justify-center overflow-hidden rounded-sm border-[0.5px] px-2.5 text-left transition-colors pointer-coarse:h-[44px] pointer-coarse:min-h-[44px]",
              s.status === "current" && "border-line-active bg-accent/12 shadow-[var(--shadow-glow)]",
              s.status === "past" && "border-line bg-subtle/60 hover:bg-subtle",
              s.status === "future" && "border-line bg-card-hover hover:border-line-active",
            )}
            title={`${s.title} · ${s.done}/${s.total} tasks`}
            aria-label={`${s.title}, ${s.done} of ${s.total} tasks done`}
          >
            <div
              className={cn(
                "truncate text-[11px] font-medium",
                s.status === "current" ? "text-fg" : "text-fg-dim",
              )}
            >
              {s.title}
            </div>
            <div className="nums mt-0.5 text-[9px] text-fg-muted">
              {s.done}/{s.total}
            </div>
            <div aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-line/40">
              <div className="h-full bg-accent" style={{ width: `${s.pct}%` }} />
            </div>
          </motion.button>
        ))}

        {model.todayPct !== null && (
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-0 top-0 z-10 w-px"
            style={{ left: `${model.todayPct}%` }}
          >
            <div className="absolute inset-y-0 w-px bg-accent-lt" />
            <motion.div
              className="absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full bg-accent-lt"
              style={{ boxShadow: "0 0 8px var(--color-accent-lt)" }}
              animate={{ scale: [1, 1.5, 1], opacity: [1, 0.6, 1] }}
              transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
            />
            <div className="absolute -bottom-4 left-1/2 -translate-x-1/2">
              <span className="label whitespace-nowrap text-accent-lt">Today</span>
            </div>
          </div>
        )}
      </div>

      {/* A phase with no dates cannot be placed, and a phase missing from a
          timeline is indistinguishable from one that does not exist. */}
      {model.undated > 0 && (
        <div className="mt-6 flex items-center gap-1.5 text-[11px] text-fg-muted">
          <CalendarOff size={12} aria-hidden />
          {model.undated} {model.undated === 1 ? "phase has" : "phases have"} no start/end date and
          {model.undated === 1 ? " is" : " are"} not on the runway.
        </div>
      )}
    </div>
  );
}
