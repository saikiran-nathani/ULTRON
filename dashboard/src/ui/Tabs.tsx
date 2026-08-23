import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

/** Underline glides between tabs via a shared layoutId. */
export function Tabs({
  tabs,
  active,
  onChange,
  layoutId = "tab-underline",
  className,
}: {
  tabs: { id: string; label: string; count?: number }[];
  active: string;
  onChange: (id: string) => void;
  layoutId?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto border-b-[0.5px] border-line",
        className,
      )}
      role="tablist"
    >
      {tabs.map((t) => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative shrink-0 px-3.5 py-3 text-[12.5px] font-medium transition-colors duration-150",
              "active:scale-[0.97]",
              on ? "text-accent-lt" : "text-fg-muted hover:text-fg-dim",
            )}
          >
            <span className="whitespace-nowrap">
              {t.label}
              {t.count != null && (
                <span className="nums ml-1.5 text-[10.5px] text-fg-muted">{t.count}</span>
              )}
            </span>
            {on && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="absolute inset-x-2.5 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
