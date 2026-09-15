import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}

/** Never leave a list blank — an empty state is part of the finish. */
export function EmptyState({ icon, title, hint, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border-[0.5px] border-dashed border-line bg-card/40 px-6 py-14 text-center",
        className,
      )}
    >
      {icon && <div className="text-accent-dim">{icon}</div>}
      <div className="display text-[15px] text-fg-dim">{title}</div>
      {hint && <p className="max-w-[40ch] text-[12px] text-fg-muted">{hint}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
