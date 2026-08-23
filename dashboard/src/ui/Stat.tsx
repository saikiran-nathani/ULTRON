import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Label + large tabular number. The atom of the dashboard. */
export function Stat({
  label,
  value,
  sub,
  color,
  size = "md",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const sizes = {
    sm: "text-[18px]",
    md: "text-[25px]",
    lg: "text-[34px]",
  } as const;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="label truncate">{label}</div>
      <div
        className={cn("nums truncate font-medium leading-none", sizes[size])}
        style={{ color: color ?? "var(--color-fg)" }}
      >
        {value}
      </div>
      {sub && <div className="truncate text-[11px] text-fg-muted">{sub}</div>}
    </div>
  );
}
