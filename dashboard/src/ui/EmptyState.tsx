import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Never leave a list blank — an empty state is part of the finish. */
export function EmptyState({
  title,
  hint,
  icon,
  action,
  className,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border-[0.5px] border-dashed border-line/70 px-6 py-12 text-center",
        className,
      )}
    >
      {icon && <div className="text-fg-muted/60">{icon}</div>}
      <div className="display text-[15px] text-fg-dim">{title}</div>
      {hint && <p className="max-w-[42ch] text-[12px] leading-relaxed text-fg-muted">{hint}</p>}
      {action}
    </div>
  );
}
