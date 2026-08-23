/** One place that maps a verdict to its colour and words. */
import type { Verdict } from "./api";

export interface StatusMeta {
  /** The single word at the top of the screen. */
  word: string;
  /** One line of context under it. */
  hint: string;
  /** A token var(), never a raw hex. */
  color: string;
  /** True when the state warrants the eye — drives the pulse animation. */
  alarm: boolean;
}

export const STATUS: Record<Verdict, StatusMeta> = {
  healthy: {
    word: "Healthy",
    hint: "beating on schedule",
    color: "var(--color-good)",
    alarm: false,
  },
  throttled: {
    word: "Throttled",
    hint: "GPU is clock-limited — step times will look worse than your code is",
    color: "var(--color-warn)",
    alarm: true,
  },
  stale: {
    word: "No signal",
    hint: "heartbeat overdue — the run may be hung or killed",
    color: "var(--color-bad)",
    alarm: true,
  },
  dead: {
    word: "Dead",
    hint: "no heartbeat; liveness check gave up on it",
    color: "var(--color-bad)",
    alarm: true,
  },
  failed: {
    word: "Failed",
    hint: "the run ended in an error",
    color: "var(--color-bad)",
    alarm: true,
  },
  finished: {
    word: "Finished",
    hint: "completed cleanly",
    color: "var(--color-accent)",
    alarm: false,
  },
  stopped: {
    word: "Stopped",
    hint: "interrupted from the keyboard",
    color: "var(--color-fg-muted)",
    alarm: false,
  },
  "no-run": {
    word: "Idle",
    hint: "no run has reported yet",
    color: "var(--color-fg-muted)",
    alarm: false,
  },
};

export const statusOf = (v: Verdict | undefined): StatusMeta => STATUS[v ?? "no-run"] ?? STATUS["no-run"];

export const levelColor = (level: string): string =>
  level === "critical"
    ? "var(--color-bad)"
    : level === "warn"
      ? "var(--color-warn)"
      : "var(--color-info)";

/** Temperature → colour. Laptop GPUs throttle around 87°C. */
export const tempColor = (t: number | null): string => {
  if (t == null) return "var(--color-fg-muted)";
  if (t >= 85) return "var(--color-bad)";
  if (t >= 75) return "var(--color-warn)";
  return "var(--color-good)";
};
