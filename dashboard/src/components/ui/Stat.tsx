import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface StatProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  className?: string;
  /** Visual weight. The screen's most important datum takes `lg`. */
  size?: "sm" | "md" | "lg";
}

/** Micro-label + large tabular number — the core stat tile. */
const STAT_SIZES = { sm: "text-[18px]", md: "text-[25px]", lg: "text-[34px]" } as const;

export function Stat({ label, value, sub, color, className, size = "md" }: StatProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="label truncate">{label}</div>
      <div
        className={cn("nums font-medium leading-none", STAT_SIZES[size])}
        style={{ color: color ?? "var(--color-fg)" }}
      >
        {value}
      </div>
      {sub && <div className="truncate text-[11px] text-fg-muted">{sub}</div>}
    </div>
  );
}
