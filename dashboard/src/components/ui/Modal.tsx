import { useEffect, useId, type ReactNode } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";

interface ModalProps {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * Required, unlike in the source app, where omitting it fell back to a
   * global `setModal(null)`. That store does not exist here, and a modal whose
   * close path is implicit is a modal that silently cannot be closed if the
   * caller forgets — so the obligation is in the type instead.
   */
  onClose: () => void;
  width?: number;
}

export function Modal({ title, children, footer, onClose, width = 460 }: ModalProps) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      // Padding is written side-by-side rather than as `p-4 md:p-6` because
      // the bottom needs the home-indicator inset folded in, and a bare `p-*`
      // alongside a `pb-*` is the ordering trap theme.css warns about. Spelled
      // out, nothing competes: desktop is still a flat 24px.
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 pt-4 pb-[max(env(safe-area-inset-bottom),1rem)] md:px-6 md:pt-6 md:pb-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div aria-hidden className="absolute inset-0 backdrop-blur-[1px]"
        style={{ background: "var(--color-scrim)" }} onClick={onClose} />
      {/* `dvh` below `md` so a phone's collapsing toolbars can't push the
          footer (Cancel / Save) off-screen; `vh` == `dvh` on the desktop. */}
      <motion.div
        className="relative z-10 flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-lg border-[0.5px] border-line-active bg-panel md:max-h-[85vh]"
        style={{ maxWidth: width }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <header className="flex items-center justify-between gap-3 border-b-[0.5px] border-line px-5 py-3.5">
          <h2 id={titleId} className="display text-[15px] text-fg">
            {title}
          </h2>
          {/* The source grew this hit area with a bespoke hit-target utility
              class, which is not part of this app's base layer, so the target
              is stated here — and only on a coarse pointer, since giving the
              button a box on the desktop would nudge the glyph off the
              position the header was measured at. */}
          <button
            onClick={onClose}
            className="shrink-0 rounded-xs text-fg-muted transition-colors hover:text-fg pointer-coarse:inline-grid pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px] pointer-coarse:place-items-center"
            aria-label="Close"
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t-[0.5px] border-line px-5 py-3">
            {footer}
          </footer>
        )}
      </motion.div>
    </motion.div>
  );
}
