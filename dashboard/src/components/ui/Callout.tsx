import type { ReactNode } from "react";
import { Card } from "./Card";
import { cn } from "@/lib/cn";

/**
 * Highlighted insight card with an icon + micro-label header. `tone` colours
 * the header and the left rule; pass a semantic token to make it read as a
 * warning or a failure rather than as the accent.
 */
export function Callout({
  icon,
  label,
  tone = "var(--color-accent)",
  actions,
  children,
  className,
}: {
  icon?: ReactNode;
  label: string;
  tone?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-5", className)} active>
      <div className="label mb-2 flex items-center gap-1.5" style={{ color: tone }}>
        {icon}
        {label}
        {actions && <span className="ml-auto flex items-center gap-1">{actions}</span>}
      </div>
      <div className="text-[12.5px] leading-relaxed text-fg-dim">{children}</div>
    </Card>
  );
}
