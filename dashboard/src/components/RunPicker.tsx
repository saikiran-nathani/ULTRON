import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { EASE } from "@/lib/motion";
import { dayClock, duration } from "@/lib/format";
import type { Run } from "@/lib/api";

const DOT: Record<string, string> = {
  running: "var(--color-good)",
  finished: "var(--color-accent)",
  failed: "var(--color-bad)",
  dead: "var(--color-bad)",
  stopped: "var(--color-fg-muted)",
};

export function RunPicker({
  runs,
  selected,
  onSelect,
}: {
  runs: Run[];
  selected: Run | null;
  onSelect: (runId: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  if (runs.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "flex min-h-[44px] items-center gap-2.5 rounded-sm border-[0.5px] border-line bg-card px-3.5 py-2",
          "text-[12px] text-fg-dim shadow-card transition-all duration-150 ease-[var(--ease-signature)]",
          "hover:border-line-active hover:bg-card-hover hover:text-fg active:scale-[0.97]",
        )}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{
            background: DOT[selected?.status ?? "stopped"] ?? "var(--color-fg-muted)",
            boxShadow: `0 0 6px ${DOT[selected?.status ?? "stopped"] ?? "transparent"}`,
          }}
        />
        <span className="max-w-[150px] truncate">{selected?.name ?? "select run"}</span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")}
        />
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="absolute right-0 z-50 mt-2 max-h-[62vh] w-[290px] overflow-y-auto rounded-md border-[0.5px] border-line-active bg-panel p-1.5 shadow-[var(--shadow-pop)]"
            >
              {runs.map((r) => {
                const on = r.id === selected?.id;
                return (
                  <button
                    key={r.id}
                    onClick={() => {
                      onSelect(r.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-sm px-3 py-2.5 text-left transition-colors",
                      on ? "bg-accent/10 text-fg" : "text-fg-dim hover:bg-card-hover hover:text-fg",
                    )}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: DOT[r.status] ?? "var(--color-fg-muted)" }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px]">{r.name}</span>
                      <span className="nums block text-[10px] text-fg-muted">
                        {dayClock(r.started_at)} · {duration((r.ended_at ?? Date.now() / 1000) - r.started_at)} ·{" "}
                        {r.last_step} steps
                      </span>
                    </span>
                    {on && <Check size={13} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
