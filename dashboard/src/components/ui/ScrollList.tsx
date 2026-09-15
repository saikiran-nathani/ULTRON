import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A vertically-scrolling list container with a compact height cap, so a long
 * record list stays reachable by scrolling rather than being truncated behind
 * a "show more". Scrollbars are hidden app-wide (theme.css), so the scroll
 * stays visually clean. The one place to tune list-scroll behaviour.
 */
export function ScrollList({
  maxH = 268,
  className,
  children,
}: {
  /** Visible height cap in px (~8 rows by default). */
  maxH?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    // `overscroll-contain` so a flick that reaches the end of this list stops
    // there instead of handing the momentum to the page behind it — on iOS
    // that chained scroll drags the whole screen and loses the user's place.
    <div className={cn("overflow-y-auto overscroll-contain", className)} style={{ maxHeight: maxH }}>
      {children}
    </div>
  );
}
