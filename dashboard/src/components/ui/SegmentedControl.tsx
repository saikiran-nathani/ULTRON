import { cn } from "@/lib/cn";

export interface SegOption {
  id: string;
  label: string;
  /** Fill colour when active. Defaults to the accent. */
  color?: string;
}

/** Multi-state segmented selector. */
export function SegmentedControl({
  options,
  value,
  onChange,
  className,
}: {
  options: SegOption[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-sm border-[0.5px] border-line p-0.5",
        className,
      )}
      role="radiogroup"
    >
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            onClick={() => onChange(o.id)}
            title={o.label}
            role="radio"
            aria-checked={on}
            // Same `pointer-coarse:` floor as Button, for the same reason: the
            // source's `md:min-h-0` cancelled the touch target on the iPad.
            className={cn(
              "rounded-xs px-2 py-1 text-[10px] uppercase tracking-wider transition-colors pointer-coarse:min-h-[44px]",
              on ? "text-bg" : "text-fg-muted hover:text-fg-dim",
            )}
            style={on ? { background: o.color ?? "var(--color-accent)" } : {}}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
