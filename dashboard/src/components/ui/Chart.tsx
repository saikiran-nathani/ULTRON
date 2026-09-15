/**
 * Hand-rolled SVG charts.
 *
 * No charting library: every colour then comes from a token, the bundle stays
 * small enough to load over cellular, and we can build the one interaction an
 * iPad actually needs — drag-to-scrub, since there is no cursor to hover with.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { metric as fmtMetric } from "@/lib/format";

export type Point = [number, number];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Scale {
  x: (v: number) => number;
  y: (v: number) => number;
  /**
   * Value at a fraction of the plot height, 0 = top. Must be used for axis
   * labels instead of lerping minY..maxY: on a log axis the midpoint of the
   * *pixels* is the geometric mean of the values, not the arithmetic one, and
   * lerping silently mislabels the gridline.
   */
  valueAt: (t: number) => number;
  minY: number;
  maxY: number;
  log: boolean;
}

function buildScale(
  data: Point[],
  w: number,
  h: number,
  pad: { t: number; r: number; b: number; l: number },
  log: boolean,
): Scale | null {
  if (data.length === 0 || w <= 0) return null;
  const xs = data.map((d) => d[0]);
  const ysRaw = data.map((d) => d[1]).filter(Number.isFinite);
  if (ysRaw.length === 0) return null;

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  let minY = Math.min(...ysRaw);
  let maxY = Math.max(...ysRaw);

  // Log scale is only meaningful for strictly-positive data (loss curves).
  const useLog = log && minY > 0 && maxY / minY > 8;
  const tf = (v: number) => (useLog ? Math.log10(Math.max(v, Number.MIN_VALUE)) : v);
  const nonNegative = minY >= 0;

  let lo = tf(minY);
  let hi = tf(maxY);
  if (hi === lo) {
    // A flat series still deserves a line through the middle.
    hi = lo + Math.abs(lo || 1) * 0.5;
    lo = lo - Math.abs(lo || 1) * 0.5;
  } else {
    const padY = (hi - lo) * 0.12;
    lo -= padY;
    hi += padY;
  }
  // Padding must not invent negative values under a series that never goes
  // there — a loss axis running to -0.13 reads as a bug in the model.
  if (!useLog && nonNegative && lo < 0) lo = 0;
  minY = useLog ? Math.pow(10, lo) : lo;
  maxY = useLog ? Math.pow(10, hi) : hi;

  const spanX = maxX - minX || 1;
  const inv = (u: number) => (useLog ? Math.pow(10, u) : u);
  return {
    x: (v) => pad.l + ((v - minX) / spanX) * (w - pad.l - pad.r),
    y: (v) => {
      const t = (tf(v) - lo) / (hi - lo || 1);
      return pad.t + (1 - t) * (h - pad.t - pad.b);
    },
    valueAt: (t) => inv(hi - t * (hi - lo)),
    minY,
    maxY,
    log: useLog,
  };
}

const linePath = (data: Point[], s: Scale) =>
  data
    .filter((d) => Number.isFinite(d[1]))
    .map((d, i) => `${i === 0 ? "M" : "L"}${s.x(d[0]).toFixed(2)},${s.y(d[1]).toFixed(2)}`)
    .join(" ");

/* ── Sparkline ─────────────────────────────────────────────────────────── */

/** A sparkline over timestamped points, sharing `LineChart`'s geometry and log
 * scaling. Renamed from `Sparkline` when the two kits merged: the ported kit
 * already had a `Sparkline` taking a plain `number[]`, and they are different
 * APIs for different data rather than two versions of one component. Naming
 * them apart is what stops a caller passing the wrong shape and getting an
 * empty chart. */
export function TimeSeriesSparkline({
  data,
  color = "var(--color-accent)",
  height = 34,
  log = false,
  className,
}: {
  data: Point[];
  color?: string;
  height?: number;
  log?: boolean;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradId = useId().replace(/:/g, "");
  const pad = { t: 3, r: 2, b: 3, l: 2 };
  const scale = useMemo(
    () => buildScale(data, width, height, pad, log),
    [data, width, height, log],
  );

  return (
    <div ref={ref} className={cn("w-full", className)} style={{ height }}>
      {scale && width > 0 && (
        <svg width={width} height={height} aria-hidden>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`${linePath(data, scale)} L${scale.x(data[data.length - 1]![0])},${height - pad.b} L${scale.x(data[0]![0])},${height - pad.b} Z`}
            fill={`url(#${gradId})`}
          />
          <path
            d={linePath(data, scale)}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

/* ── LineChart with drag-to-scrub ──────────────────────────────────────── */

export function LineChart({
  data,
  color = "var(--color-accent)",
  height = 200,
  log = false,
  metricKey = "",
  yLabel,
  xFormat = (v) => v.toFixed(0),
  xPrefix = "@",
  className,
}: {
  data: Point[];
  color?: string;
  height?: number;
  log?: boolean;
  metricKey?: string;
  yLabel?: string;
  /** x is a step number by default; pass a clock formatter for time series. */
  xFormat?: (v: number) => string;
  xPrefix?: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const gradId = useId().replace(/:/g, "");
  const [cursor, setCursor] = useState<number | null>(null);

  const pad = { t: 12, r: 10, b: 20, l: 46 };
  const scale = useMemo(
    () => buildScale(data, width, height, pad, log),
    [data, width, height, log],
  );

  const onScrub = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!scale || data.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      // Nearest point by screen distance — robust to uneven step spacing.
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < data.length; i++) {
        const d = Math.abs(scale.x(data[i]![0]) - px);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      setCursor(best);
    },
    [scale, data],
  );

  const active = cursor != null ? data[cursor] : undefined;
  const last = data[data.length - 1];
  const shown = active ?? last;

  return (
    <div ref={ref} className={cn("relative w-full select-none", className)} style={{ height }}>
      {scale && width > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            className="touch-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              onScrub(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons > 0 || e.pointerType === "mouse") onScrub(e);
            }}
            onPointerUp={() => setCursor(null)}
            onPointerLeave={() => setCursor(null)}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* horizontal rules + y labels */}
            {[0, 0.5, 1].map((t) => {
              const y = pad.t + t * (height - pad.t - pad.b);
              const v = scale.valueAt(t);
              return (
                <g key={t}>
                  <line
                    x1={pad.l}
                    x2={width - pad.r}
                    y1={y}
                    y2={y}
                    stroke="var(--color-hairline)"
                    strokeWidth={0.5}
                  />
                  <text
                    x={pad.l - 7}
                    y={y + 3}
                    textAnchor="end"
                    className="nums"
                    fontSize="9"
                    fill="var(--color-fg-muted)"
                  >
                    {fmtMetric(v, metricKey)}
                  </text>
                </g>
              );
            })}

            <path
              d={`${linePath(data, scale)} L${scale.x(last![0])},${height - pad.b} L${scale.x(data[0]![0])},${height - pad.b} Z`}
              fill={`url(#${gradId})`}
            />
            <path
              d={linePath(data, scale)}
              fill="none"
              stroke={color}
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ filter: `drop-shadow(0 0 6px color-mix(in srgb, ${color} 30%, transparent))` }}
            />

            {/* x labels: first and last */}
            <text x={pad.l} y={height - 5} fontSize="9" className="nums" fill="var(--color-fg-muted)">
              {xFormat(data[0]![0])}
            </text>
            <text
              x={width - pad.r}
              y={height - 5}
              textAnchor="end"
              fontSize="9"
              className="nums"
              fill="var(--color-fg-muted)"
            >
              {xFormat(last![0])}
            </text>

            {active && (
              <g>
                <line
                  x1={scale.x(active[0])}
                  x2={scale.x(active[0])}
                  y1={pad.t}
                  y2={height - pad.b}
                  stroke="var(--color-line-active)"
                  strokeWidth={1}
                />
                <circle
                  cx={scale.x(active[0])}
                  cy={scale.y(active[1])}
                  r={4}
                  fill="var(--color-bg)"
                  stroke={color}
                  strokeWidth={2}
                />
              </g>
            )}
          </svg>

          {/* readout — the scrubbed value, or the latest when idle */}
          {shown && (
            <div className="pointer-events-none absolute right-2 top-1 flex items-baseline gap-2">
              {scale.log && <span className="label">log</span>}
              {active && (
                <span className="nums text-[10px] text-fg-muted">
                  {xPrefix}
                  {xFormat(active[0])}
                </span>
              )}
              <span className="nums text-[13px] font-medium" style={{ color }}>
                {fmtMetric(shown[1], metricKey)}
              </span>
              {yLabel && <span className="label">{yLabel}</span>}
            </div>
          )}
        </>
      ) : (
        <div className="grid h-full place-items-center text-[11px] text-fg-muted">
          no data yet
        </div>
      )}
    </div>
  );
}
