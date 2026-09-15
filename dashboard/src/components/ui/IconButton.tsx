import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  /** Accessible name; also the tooltip. */
  label: string;
  danger?: boolean;
}

/**
 * A bare icon control.
 *
 * Two things changed on the way over, both for the same reason — at rest, on a
 * touch screen, the source rendered this as a muted glyph on nothing: no
 * border, no fill, 36px of target. It was legible as a button only once a
 * cursor was over it, which is a state a finger cannot enter. So on a coarse
 * pointer it gets a resting surface and a 44px box; on a fine pointer nothing
 * applies and the desktop rendering is byte-for-byte the original.
 *
 * `min-w`/`min-h` rather than bigger `h`/`w`: minimums clamp the explicit
 * size instead of competing with it, so there is no variant-order race with
 * the `md:` metrics below.
 */
export function IconButton({ icon, label, danger, className, ...rest }: IconButtonProps) {
  return (
    <button
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-xs border border-transparent text-fg-muted transition-all duration-100 hover:bg-card-hover active:scale-95 md:h-7 md:w-7",
        "pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] pointer-coarse:border-line pointer-coarse:bg-card/60 pointer-coarse:text-fg-dim",
        danger ? "hover:text-[var(--color-bad)]" : "hover:text-fg",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
