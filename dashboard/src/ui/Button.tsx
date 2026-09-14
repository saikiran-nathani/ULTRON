import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "ghost" | "subtle" | "danger";

const VARIANTS: Record<Variant, string> = {
  // A vertical gradient with an inner top highlight rather than one flat
  // fill. At full-width-and-44px-tall, a single saturated colour reads as a
  // poster; the gradient plus the 1px highlight is the same machined-metal
  // treatment the cards use, so the loudest element on the screen still
  // belongs to the same object as everything around it.
  primary:
    "bg-gradient-to-b from-accent-lt to-accent text-bg border border-accent-lt/30 font-semibold " +
    "shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] " +
    "hover:from-accent-lt hover:to-accent-lt hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.34),var(--shadow-glow)]",
  ghost:
    "bg-transparent text-fg-dim hover:text-fg hover:bg-card-hover border border-line hover:border-line-active",
  subtle:
    "bg-card text-fg-dim hover:text-fg hover:bg-card-hover border border-line shadow-card",
  danger:
    "bg-transparent text-[var(--color-bad)] hover:bg-[color-mix(in_srgb,var(--color-bad)_14%,transparent)] border border-[color-mix(in_srgb,var(--color-bad)_30%,transparent)]",
};

// Touch targets: `md` lands at 44px tall including border, which is Apple's
// minimum. Do not shrink these below `sm` on a surface meant for fingers.
const SIZES = {
  sm: "px-3 py-2 text-[11.5px] gap-1.5 rounded-sm min-h-[36px]",
  md: "px-4 py-2.5 text-[12.5px] gap-2 rounded-sm min-h-[44px]",
} as const;

export function Button({
  variant = "ghost",
  size = "md",
  icon,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: keyof typeof SIZES;
  icon?: ReactNode;
}) {
  return (
    <button
      className={cn(
        "group/btn relative inline-flex items-center justify-center overflow-hidden whitespace-nowrap",
        "transition-all duration-150 ease-[var(--ease-signature)] active:scale-[0.97]",
        "disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {variant === "primary" && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 group-hover/btn:translate-x-full"
        />
      )}
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  danger,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cn(
        "inline-grid h-11 w-11 place-items-center rounded-sm border-[0.5px] border-line bg-card/60 text-fg-muted",
        "transition-all duration-150 ease-[var(--ease-signature)]",
        "hover:border-line-active hover:bg-card-hover hover:text-fg active:scale-[0.94]",
        "disabled:pointer-events-none disabled:opacity-40",
        danger && "hover:text-[var(--color-bad)]",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
