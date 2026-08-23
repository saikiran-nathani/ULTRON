import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** SVG arc: subtle track + accent fill, animated dashoffset, accent bloom. */
export function ProgressRing({
  value,
  size = 64,
  stroke = 5,
  color = "var(--color-accent)",
  track = "var(--color-subtle)",
  children,
  className,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  track?: string;
  children?: ReactNode;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const offset = circ - (pct / 100) * circ;

  return (
    <div
      className={cn("relative inline-grid place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          style={{
            transition: "stroke-dashoffset .7s var(--ease-signature), stroke .4s linear",
            filter: `drop-shadow(0 0 5px color-mix(in srgb, ${color} 55%, transparent))`,
          }}
        />
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}

export function ProgressBar({
  value,
  color = "var(--color-accent)",
  className,
}: {
  value: number;
  color?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-subtle", className)}>
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-[var(--ease-signature)]"
        style={{
          width: `${pct}%`,
          background: color,
          boxShadow: `0 0 8px color-mix(in srgb, ${color} 50%, transparent)`,
        }}
      />
    </div>
  );
}
