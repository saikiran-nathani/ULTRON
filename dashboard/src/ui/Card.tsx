import { useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Accent left-rule: selected / current. */
  active?: boolean;
  /** Clickable: lift + cursor sheen on pointer, press-scale on touch. */
  interactive?: boolean;
  accent?: string;
}

export function Card({
  className,
  active,
  interactive,
  accent,
  children,
  onMouseMove,
  style,
  ...rest
}: CardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (interactive && ref.current) {
      const r = ref.current.getBoundingClientRect();
      ref.current.style.setProperty("--mx", `${e.clientX - r.left}px`);
      ref.current.style.setProperty("--my", `${e.clientY - r.top}px`);
    }
    onMouseMove?.(e);
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      style={{ ...style, ...(accent ? ({ "--card-accent": accent } as React.CSSProperties) : {}) }}
      className={cn(
        "relative rounded-md border-[0.5px] border-line bg-card shadow-card",
        "transition-all duration-200 ease-[var(--ease-signature)]",
        active && "border-l-2 border-l-[var(--card-accent,var(--color-accent))]",
        interactive &&
          "group/card cursor-pointer hover:-translate-y-0.5 hover:border-line-active hover:bg-card-hover active:scale-[0.985] active:border-line-active",
        className,
      )}
      {...rest}
    >
      {interactive && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover/card:opacity-100"
          style={{
            background:
              "radial-gradient(420px circle at var(--mx,50%) var(--my,0%), color-mix(in srgb, var(--color-accent) 11%, transparent), transparent 45%)",
          }}
        />
      )}
      {children}
    </div>
  );
}

/** Card header: micro-label on the left, optional control on the right. */
export function CardHead({
  label,
  right,
  className,
}: {
  label: string;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <span className="label">{label}</span>
      {right}
    </div>
  );
}
