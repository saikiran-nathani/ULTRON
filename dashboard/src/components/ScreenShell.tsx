import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function ScreenShell({
  title,
  eyebrow,
  actions,
  children,
  className,
}: {
  title?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "safe-t mx-auto flex min-h-full max-w-[1160px] flex-col px-5 sm:px-8",
        // Room for the bottom tab bar in portrait; normal padding with a sidebar.
        // The inset is added, not maxed: the tab bar's own height and the home
        // indicator stack, so on an iPhone the last row of content would
        // otherwise sit under the indicator.
        "pb-[calc(104px+env(safe-area-inset-bottom))] lg:pb-14",
        className,
      )}
    >
      {(title || actions) && (
        <header className="rise flex items-end justify-between gap-4 pb-6 pt-8 lg:pt-12">
          <div className="min-w-0">
            {eyebrow && (
              <div className="label mb-2 flex items-center gap-2 text-accent-dim">
                <span className="inline-block h-px w-5 bg-accent-dim/60" />
                {eyebrow}
              </div>
            )}
            {title && (
              <h1 className="display truncate text-[26px] leading-none text-fg sm:text-[30px]">
                {title}
              </h1>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="flex-1">{children}</div>
    </div>
  );
}
