import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { clampPct } from "./ProgressBar";

interface ProgressRingProps {
  /** 0–100. */
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  /** The unfilled arc. Defaults to a hairline of the fill colour. */
  track?: string;
  className?: string;
  children?: ReactNode;
}

/** SVG arc — subtle track + accent fill, animated `stroke-dashoffset`. */
export function ProgressRing({
  value,
  size = 64,
  stroke = 5,
  color = "var(--color-accent)",
  track,
  className,
  children,
}: ProgressRingProps) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ - (clampPct(value) / 100) * circ;
  return (
    <div
      className={cn("relative inline-grid place-items-center", className)}
      style={{ width: size, height: size }}
    >
      {/* Hidden from the tree: the arc is a picture of the number that
          `children` already states in text. */}
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={track ?? "var(--color-subtle)"}
          strokeWidth={stroke}
        />
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
            transition: "stroke-dashoffset 0.7s var(--ease-signature)",
            filter: `drop-shadow(0 0 5px color-mix(in srgb, ${color} 55%, transparent))`,
          }}
        />
      </svg>
      {children && <div className="absolute inset-0 grid place-items-center">{children}</div>}
    </div>
  );
}
