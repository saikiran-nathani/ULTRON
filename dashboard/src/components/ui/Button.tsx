import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  // A gradient rather than a flat fill, and an inner top highlight — the same
  // machined treatment the cards use, so the loudest element on the screen
  // still belongs to the same object as everything around it. Kept from the
  // app this kit merged into; the flat version it replaced read as a separate
  // widget pasted onto the surface.
  primary:
    "bg-gradient-to-b from-accent-lt to-accent text-bg border border-accent-lt/30 font-semibold " +
    "shadow-[inset_0_1px_0_var(--color-specular)] " +
    "hover:from-accent-lt hover:to-accent-lt hover:shadow-[inset_0_1px_0_var(--color-specular),var(--shadow-glow)]",
  ghost:
    "bg-transparent text-fg-dim hover:text-fg hover:bg-card-hover border border-line hover:border-line-active",
  subtle: "bg-card text-fg-dim hover:text-fg hover:bg-card-hover border border-line shadow-card",
  danger:
    "bg-transparent text-[var(--color-bad)] hover:bg-[color-mix(in_srgb,var(--color-bad)_14%,transparent)] border border-[color-mix(in_srgb,var(--color-bad)_30%,transparent)]",
};

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-[11.5px] gap-1.5 rounded-sm",
  md: "px-4 py-2 text-[12.5px] gap-2 rounded-sm",
};

export function Button({
  variant = "ghost",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        // The 44px floor is hung off `pointer-coarse:` rather than a
        // breakpoint, because the source used `min-h-11 md:min-h-0` and an
        // iPad is both `md` and a thumb — the breakpoint gave the floor back
        // on exactly the device that needed it most. Asking about the pointer
        // asks the question that matters, and leaves the two `min-height`
        // declarations from ever competing: a fine pointer gets none at all,
        // so desktop metrics stay padding-driven and untouched.
        "group/btn relative inline-flex items-center justify-center overflow-hidden whitespace-nowrap transition-all duration-150 ease-[var(--ease-signature)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40 pointer-coarse:min-h-[44px]",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {variant === "primary" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-[var(--color-specular)] to-transparent transition-transform duration-700 group-hover/btn:translate-x-full"
        />
      )}
      {icon}
      {children}
    </button>
  );
}
