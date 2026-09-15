/**
 * The hero: is the run alive, and how long since it last said so.
 *
 * The most important datum on the screen gets the largest visual weight. On a
 * tablet you glance at this from across the room, so the verdict is a word in
 * the display face and the heartbeat is a ring that visibly drains toward the
 * liveness timeout rather than a number you have to read.
 */
import { CountUp, usePrefersReducedMotion } from "@/lib/motion";
import { statusOf } from "@/lib/status";
import { duration } from "@/lib/format";
import type { Heartbeat, Run, Verdict } from "@/lib/api";
import { ProgressRing } from "@/components/ui";

export function Pulse({
  status,
  run,
  heartbeat,
  size = 208,
}: {
  status: Verdict;
  run: Run | null;
  heartbeat: Heartbeat | null;
  size?: number;
}) {
  const meta = statusOf(status);
  const reduced = usePrefersReducedMotion();
  const live = run?.status === "running";

  // Ring reads as remaining life: full just after a beat, empty at the timeout.
  const freshness =
    heartbeat && heartbeat.timeout > 0
      ? Math.max(0, Math.min(100, (1 - heartbeat.age / heartbeat.timeout) * 100))
      : run
        ? 0
        : 100;

  const pinging = live && !meta.alarm && !reduced;

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center sm:gap-8">
      <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
        {/* sonar sweep — only while genuinely healthy and moving */}
        {pinging && (
          <>
            <span
              className="sonar-ping absolute rounded-full border"
              style={{
                width: size * 0.86,
                height: size * 0.86,
                borderColor: `color-mix(in srgb, ${meta.color} 40%, transparent)`,
              }}
            />
            <span
              className="sonar-ping absolute rounded-full border"
              style={{
                width: size * 0.86,
                height: size * 0.86,
                borderColor: `color-mix(in srgb, ${meta.color} 26%, transparent)`,
                animationDelay: "1.4s",
              }}
            />
          </>
        )}

        {/* concentric depth rings — the instrument bezel */}
        <span
          className="absolute rounded-full border-[0.5px]"
          style={{ width: size * 0.62, height: size * 0.62, borderColor: "var(--color-hairline)" }}
        />
        <span
          className="absolute rounded-full border-[0.5px]"
          style={{ width: size * 0.42, height: size * 0.42, borderColor: "var(--color-hairline)" }}
        />

        <ProgressRing value={freshness} size={size} stroke={6} color={meta.color}>
          <div className="flex flex-col items-center gap-1">
            {/* CSS, not a JS tween: this word is the single most important
                thing on the screen, so it must never be left mid-fade by a
                backgrounded tab. Keyed so it re-plays when the verdict flips. */}
            <div
              key={meta.word}
              className="rise display text-[26px] leading-none"
              style={{ color: meta.color }}
            >
              {meta.word}
            </div>
            {run && (
              <div className="nums text-[11px] text-fg-muted">
                step <CountUp value={run.last_step} className="text-fg-dim" />
              </div>
            )}
          </div>
        </ProgressRing>
      </div>

      {/* w-full matters and min-w-0 alone does not.
          Below `sm` the parent is `flex-col`, so `flex-1` sizes this on the
          MAIN axis — which is vertical — and leaves the width unconstrained.
          The Field row below then takes its natural 474px inside a 375px
          viewport, overflowing 49px left and 50px right. Nothing scrolls, so
          that content is not merely awkward: it is unreachable. It also
          stopped the `truncate` on the run name from ever engaging, because
          truncation needs a bounded width.
          `w-full` bounds it when stacked; `flex-1` still does the work at sm+. */}
      <div className="min-w-0 w-full flex-1 text-center sm:text-left">
        <div className="label mb-2 flex items-center justify-center gap-2 text-accent-dim sm:justify-start">
          <span className="inline-block h-px w-5 bg-accent-dim/60" />
          {live ? "live run" : "last run"}
        </div>

        <h1 className="display truncate text-[30px] leading-none text-fg sm:text-[36px]">
          {run?.name ?? "nothing running"}
        </h1>

        <p className="mt-3 max-w-[46ch] text-[12.5px] leading-relaxed text-fg-dim">{meta.hint}</p>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 sm:justify-start">
          <Field
            label="last beat"
            value={heartbeat ? duration(heartbeat.age) + " ago" : "—"}
            color={heartbeat && heartbeat.age > heartbeat.timeout ? "var(--color-bad)" : undefined}
          />
          <Field
            label="running for"
            value={
              run
                ? duration((run.ended_at ?? Date.now() / 1000) - run.started_at)
                : "—"
            }
          />
          <Field label="dead after" value={heartbeat ? duration(heartbeat.timeout) : "—"} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className="nums text-[14px]" style={{ color: color ?? "var(--color-fg)" }}>
        {value}
      </span>
    </div>
  );
}
