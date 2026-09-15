import { cn } from "@/lib/cn";

interface ProgressBarProps {
  /** 0–100. Clamped, so a ratio passed by mistake simply reads as empty. */
  value: number;
  color?: string;
  className?: string;
  height?: number;
}

export function ProgressBar({
  value,
  color = "var(--color-accent)",
  className,
  height = 5,
}: ProgressBarProps) {
  const pct = clampPct(value);
  return (
    <div
      className={cn("w-full overflow-hidden rounded-full bg-subtle", className)}
      style={{ height }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

/**
 * Shared by the bar and the ring. `NaN` folds to 0 rather than propagating:
 * a metric that has not arrived yet is a routine state here, and `width:
 * NaN%` leaves the previous width painted, which reads as live data.
 */
export function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
