import type { ReactNode } from "react";
import { Card } from "./Card";
import { cn } from "@/lib/cn";

export interface StatItem {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  onClick?: () => void;
  active?: boolean;
}

/**
 * A responsive row of stat cards. Auto-fits its columns so it reflows and
 * fills a wide window; pass `onClick` to make a cell navigable.
 *
 * A clickable cell gets `role="button"`, a tab stop and Enter/Space, because
 * `Card` is a `div` — without those the cell is a control that only a mouse
 * or a finger can reach, and VoiceOver on the iPad reads it as static text.
 */
export function StatBand({
  items,
  className,
  min = 160,
}: {
  items: StatItem[];
  className?: string;
  min?: number;
}) {
  return (
    <div
      className={cn("grid gap-3", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}
    >
      {items.map((s, i) => (
        <Card
          key={i}
          interactive={!!s.onClick}
          active={s.active}
          onClick={s.onClick}
          role={s.onClick ? "button" : undefined}
          tabIndex={s.onClick ? 0 : undefined}
          onKeyDown={
            s.onClick
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    s.onClick?.();
                  }
                }
              : undefined
          }
          className="p-4"
        >
          <div className="label">{s.label}</div>
          <div
            className="nums mt-1.5 text-[22px] leading-none"
            style={{ color: s.color ?? "var(--color-fg)" }}
          >
            {s.value}
          </div>
          {s.sub != null && s.sub !== "" && (
            <div className="mt-1 text-[11px] text-fg-muted">{s.sub}</div>
          )}
        </Card>
      ))}
    </div>
  );
}
