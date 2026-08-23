import { useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyToClipboard } from "@/lib/hub";

/**
 * Copy with visible confirmation. The confirmation matters more than usual
 * here: on iOS a copy can be silently refused (no user gesture, no permission),
 * and a button that looks like it worked but did not is worse than an error.
 */
export function CopyButton({
  text,
  resolve,
  label = "Copy",
  size = "md",
  className,
}: {
  text?: string;
  /** For secrets: fetch the real body only when the user actually copies. */
  resolve?: () => Promise<string>;
  label?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");
  // Copying a clip and then deleting it inside the confirmation window
  // unmounts the row while this timer is still pending.
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    return () => {
      alive.current = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const value = resolve ? await resolve().catch(() => null) : text;
    const ok = value != null && (await copyToClipboard(value));
    if (!alive.current) return;
    setState(ok ? "ok" : "fail");
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (alive.current) setState("idle");
    }, ok ? 1400 : 2600);
  };

  const Icon = state === "ok" ? Check : state === "fail" ? X : Copy;
  const tone =
    state === "ok"
      ? "text-[var(--color-good)] border-[color-mix(in_srgb,var(--color-good)_35%,transparent)]"
      : state === "fail"
        ? "text-[var(--color-bad)] border-[color-mix(in_srgb,var(--color-bad)_35%,transparent)]"
        : "text-fg-dim border-line hover:border-line-active hover:text-fg";

  return (
    <button
      onClick={onClick}
      title={state === "fail" ? "Copy was refused — see the banner above" : label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-sm border bg-card/60 font-medium",
        "transition-all duration-150 ease-[var(--ease-signature)] active:scale-[0.94]",
        size === "sm" ? "min-h-[34px] px-2.5 text-[11px]" : "min-h-[44px] px-3.5 text-[12px]",
        tone,
        className,
      )}
    >
      <Icon size={size === "sm" ? 12 : 13} strokeWidth={2} />
      {state === "ok" ? "Copied" : state === "fail" ? "Blocked" : label}
    </button>
  );
}
