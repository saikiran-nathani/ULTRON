import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card } from "./Card";
import { cn } from "@/lib/cn";

/**
 * A card whose body reveals on a chevron toggle. `header` is the
 * always-visible summary and is itself the toggle; `actions` sit to its right,
 * outside it, so tapping an action never also collapses the card.
 * Uncontrolled by default — pass `open`/`onToggle` to drive it.
 */
export function ExpandableCard({
  header,
  actions,
  children,
  active,
  defaultOpen = false,
  open: openProp,
  onToggle,
  className,
  id,
}: {
  header: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  active?: boolean;
  defaultOpen?: boolean;
  open?: boolean;
  onToggle?: () => void;
  className?: string;
  id?: string;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = onToggle ?? (() => setOpenState((v) => !v));

  return (
    <Card id={id} className={cn("p-5", className)} active={active}>
      <div className="flex items-start gap-3">
        <button
          onClick={toggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-2 pointer-coarse:min-h-[44px] text-left"
        >
          <div className="min-w-0 flex-1">{header}</div>
          <ChevronDown
            size={14}
            aria-hidden
            className={cn(
              "mt-0.5 shrink-0 text-fg-muted transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && <div className="mt-4 border-t-[0.5px] border-line pt-4">{children}</div>}
    </Card>
  );
}
