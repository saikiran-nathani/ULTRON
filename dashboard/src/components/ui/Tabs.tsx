import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

export interface TabDef {
  id: string;
  label: string;
  /** Optional badge, for "Projects 7". Omitted rather than shown as 0. */
  count?: number;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  /**
   * The shared `layoutId` the underline glides on. Only needs setting when two
   * strips are mounted at once — otherwise both claim the same id and the
   * underline teleports between them.
   */
  layoutId?: string;
  className?: string;
}

export function Tabs({ tabs, active, onChange, layoutId = "tab-underline", className }: TabsProps) {
  return (
    // `overflow-x-auto` + `shrink-0` below: five or six tabs do not fit across
    // a 375px phone, and without this they compress until the labels are
    // unreadable and the last one is unreachable.
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
              "relative shrink-0 px-3.5 py-2.5 text-[12.5px] font-medium transition-colors duration-150 pointer-coarse:min-h-[44px]",
              on ? "text-accent-lt" : "text-fg-muted hover:text-fg-dim",
            )}
          >
            {t.label}
            {/* Rendered only when there is something to count. A badge reading
                "0" says "this is empty" in the one place a person is deciding
                whether to look, which is worse than saying nothing. */}
            {t.count !== undefined && t.count > 0 && (
              <span className={cn("nums ml-1.5 text-[10.5px]", on ? "text-accent-dim" : "text-fg-muted")}>
                {t.count}
              </span>
            )}
            {on && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-x-2.5 -bottom-px h-[2px] rounded-full bg-accent shadow-[0_0_8px_color-mix(in_srgb,var(--color-accent)_60%,transparent)]"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
