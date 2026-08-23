/** The one easing, the mount choreography, and numbers that ease to their value. */
import { Children, cloneElement, isValidElement, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { cn } from "./cn";

export const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Mount choreography is CSS, not Framer — see the note in theme.css. A tablet
 * backgrounds this app constantly, requestAnimationFrame stops when it does,
 * and a JS tween interrupted at 40% opacity stays at 40% opacity. CSS
 * animations with `both` fill always settle on their final keyframe.
 *
 * Stagger hands each child its index as `--i`; `.rise` turns that into a
 * delay. Same cascade, none of the fragility.
 */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  let i = 0;
  return (
    <div className={className}>
      {Children.map(children, (child) => {
        if (!isValidElement(child)) return child;
        const el = child as ReactElement<{ style?: CSSProperties }>;
        return cloneElement(el, {
          style: { ...el.props.style, ["--i" as string]: i++ } as CSSProperties,
        });
      })}
    </div>
  );
}

export function Reveal({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={cn("rise", className)} style={style}>
      {children}
    </div>
  );
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** Numbers ease from their previous value rather than snapping. */
export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 0.8,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(value);
  const prev = useRef(value);

  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (from === to || !Number.isFinite(to)) {
      prev.current = to;
      setDisplay(to);
      return;
    }
    if (reduced) {
      prev.current = to;
      setDisplay(to);
      return;
    }
    const start = performance.now();
    let raf = 0;
    let latest = from;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / (duration * 1000));
      latest = from + (to - from) * (1 - Math.pow(1 - p, 3));
      setDisplay(latest);
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Record where the tween actually got to. prev.current was only
      // assigned on completion, so a value changing mid-flight — routine when
      // /api/stream pushes every 2s and the tween runs 0.8s — left the next
      // animation starting from the *previous* origin, and the step counter
      // visibly snapped backwards before climbing again.
      prev.current = latest;
    };
  }, [value, duration, reduced]);

  return (
    <span className={className}>
      {prefix}
      {Number.isFinite(display)
        ? display.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : "—"}
      {suffix}
    </span>
  );
}
