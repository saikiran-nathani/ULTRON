/**
 * The proficiency radar's geometry, split from the SVG that draws it for the
 * same reason as `timeline.tsx`: a chart whose maths is wrong renders a
 * picture that is not the data, silently. On a screen whose job is to tell you
 * where you are weakest, a polygon pointing the wrong way is worse than no
 * polygon.
 *
 * Ported from nexus's `roadmap/ProficiencyRadar.tsx`. No JSX here; `.tsx` only
 * because this directory's brief allows that extension and no other.
 */
import type { Proficiency, RoadmapLayer } from "@/lib/nexus/types";
import { byId } from "./order";

/** Ordinal, not a score. Four states, three rings. */
export const LEVEL_VALUE: Record<Proficiency, number> = {
  none: 0,
  learning: 1,
  working: 2,
  solid: 3,
};

export const LEVEL_TOKEN: Record<Proficiency, string> = {
  none: "var(--color-fg-muted)",
  learning: "var(--color-info)",
  working: "var(--color-warn)",
  solid: "var(--color-good)",
};

export const LEVEL_LABEL: Record<Proficiency, string> = {
  none: "Not started",
  learning: "Learning",
  working: "Working",
  solid: "Solid",
};

/** Proficiency in ascending order — the legend and the segmented control. */
export const LEVELS: readonly Proficiency[] = ["none", "learning", "working", "solid"];

const SIZE = 260;
const CENTRE = SIZE / 2;
const RADIUS = 92;
const MAX = 3;

export type Anchor = "start" | "middle" | "end";

export interface RadarVertex {
  id: string;
  name: string;
  level: Proficiency;
  /** The data point. */
  vx: number;
  vy: number;
  /** The axis label, just outside the outer ring. */
  lx: number;
  ly: number;
  anchor: Anchor;
}

export interface RadarModel {
  size: number;
  centre: number;
  /** Radius of the hit circle behind each vertex — see `Stack.tsx`. */
  hit: number;
  /** The three grid rings, outermost last. */
  rings: string[];
  /** Outer end of each axis spoke. */
  axes: { x: number; y: number }[];
  /** The data polygon. */
  polygon: string;
  vertices: RadarVertex[];
}

/** A point on axis `i` of `n`, at radius fraction `f`. Axis 0 points up. */
export function pointOn(i: number, n: number, f: number): [number, number] {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
  return [CENTRE + Math.cos(a) * RADIUS * f, CENTRE + Math.sin(a) * RADIUS * f];
}

const path = (points: readonly [number, number][]): string =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ") + " Z";

type LayerLike = Pick<RoadmapLayer, "id" | "name" | "proficiency">;

/**
 * The whole radar, or `null` when there is nothing a radar can show.
 *
 * Fewer than three axes is not a small radar — it is a line or a dot, which
 * reads as a broken chart. The caller falls back to the list below it, which
 * carries the same data without pretending to be a shape.
 */
export function radarModel(layers: readonly LayerLike[]): RadarModel | null {
  // Ordered by id so the axes do not rotate between devices: per-record sync
  // rebuilds arrays in id order, and a radar whose axes are in pull order
  // would be a different shape on the phone than on the laptop, with the data
  // fully converged.
  const ordered = byId(layers);
  const n = ordered.length;
  if (n < 3) return null;

  const vertices: RadarVertex[] = ordered.map((l, i) => {
    const [vx, vy] = pointOn(i, n, LEVEL_VALUE[l.proficiency] / MAX);
    const [lx, ly] = pointOn(i, n, 1.16);
    const cos = Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n);
    return {
      id: l.id,
      name: l.name,
      level: l.proficiency,
      vx,
      vy,
      lx,
      ly,
      // Labels on the left of the circle are right-aligned and vice versa, so
      // text grows away from the chart instead of over it.
      anchor: cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle",
    };
  });

  return {
    size: SIZE,
    centre: CENTRE,
    // 22 user units on a 260-unit box that renders 230–300px wide, so the
    // target is ~40–50px across. The source made the 3.5px dot itself the
    // control, which is unhittable with a thumb.
    hit: 22,
    rings: [1, 2, 3].map((lvl) => path(ordered.map((_, i) => pointOn(i, n, lvl / MAX)))),
    axes: ordered.map((_, i) => {
      const [x, y] = pointOn(i, n, 1);
      return { x, y };
    }),
    polygon: path(vertices.map((v) => [v.vx, v.vy] as [number, number])),
    vertices,
  };
}
