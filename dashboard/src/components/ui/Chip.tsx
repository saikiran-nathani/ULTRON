import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface ChipProps {
  children: ReactNode;
  /** Any CSS colour — a token var or a `color-mix`. Defaults to the accent. */
  color?: string;
  className?: string;
  /** A glowing dot before the label, for live/status chips. */
  dot?: boolean;
}

/** Pill badge, accent-tinted by default or tinted to any token colour. */
export function Chip({ children, color, className, dot }: ChipProps) {
  const c = color ?? "var(--color-accent)";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        className,
      )}
      style={{
        color: c,
        borderColor: `color-mix(in srgb, ${c} 35%, transparent)`,
        background: `color-mix(in srgb, ${c} 10%, transparent)`,
      }}
    >
      {dot && (
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: c, boxShadow: `0 0 6px ${c}` }}
        />
      )}
      {children}
    </span>
  );
}
