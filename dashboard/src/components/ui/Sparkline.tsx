interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  strokeWidth?: number;
  className?: string;
}

export interface SparklineGeometry {
  /** `points` for the trend polyline. */
  line: string;
  /** Closed `d` for the area beneath it. */
  area: string;
  /** Where the end dot goes. */
  last: { x: number; y: number };
}

/**
 * The geometry, split out from the element so it can be tested without a DOM.
 *
 * Two departures from the source, both about data this app actually produces:
 *
 * - Non-finite samples are dropped rather than plotted. A metric series here
 *   can carry `NaN` (a diverged loss, a gap in logging), and one of them
 *   poisons `min`/`max` for the whole series — every coordinate comes out
 *   `NaN`, the polyline is invalid, and the chart renders blank with no hint
 *   as to why. A line that closes over the gap is the lesser wrong.
 * - `min`/`max` are found by loop, not `Math.min(...values)`. Spreading an
 *   array as arguments is capped by the engine's stack; 240 points is fine
 *   and 200k points is a crash, and nothing in the signature says which.
 */
export function sparklineGeometry(
  values: number[],
  { width, height, strokeWidth }: { width: number; height: number; strokeWidth: number },
): SparklineGeometry | null {
  const pts = values.filter((v) => Number.isFinite(v));
  const n = pts.length;
  if (n === 0) return null;

  let min = pts[0]!;
  let max = pts[0]!;
  for (const v of pts) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const pad = strokeWidth + 1;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - min) / span);

  const coords = pts.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  return {
    line: coords.join(" "),
    area: `M ${x(0).toFixed(2)},${height} L ${coords.join(" L ")} L ${x(n - 1).toFixed(2)},${height} Z`,
    last: { x: x(n - 1), y: y(pts[n - 1]!) },
  };
}

/** Tiny inline trend line, with an optional area fill and end dot. Empty-safe. */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  color = "var(--color-accent)",
  fill = true,
  strokeWidth = 1.5,
  className,
}: SparklineProps) {
  const geo = sparklineGeometry(values, { width, height, strokeWidth });
  if (!geo) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden
    >
      {fill && (
        <path d={geo.area} fill={`color-mix(in srgb, ${color} 14%, transparent)`} stroke="none" />
      )}
      <polyline
        points={geo.line}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={geo.last.x} cy={geo.last.y} r={strokeWidth + 0.5} fill={color} />
    </svg>
  );
}
