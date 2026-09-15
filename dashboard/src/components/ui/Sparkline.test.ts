/**
 * The sparkline's geometry, which is the only part of it that can be wrong
 * quietly. A broken path does not throw and does not log — it renders a chart
 * that is simply not the data, and on a metrics dashboard that is the worst
 * failure mode available.
 *
 * No DOM here on purpose: this repo has no jsdom, and the geometry needs
 * none.
 */
import { describe, expect, it } from "vitest";
import { sparklineGeometry } from "./Sparkline";

const OPTS = { width: 100, height: 40, strokeWidth: 2 };
const pointsOf = (line: string) => line.split(" ").map((p) => p.split(",").map(Number) as [number, number]);

describe("sparklineGeometry", () => {
  it("returns null for an empty series", () => {
    expect(sparklineGeometry([], OPTS)).toBeNull();
  });

  it("spans the full width and puts the last point at the right edge", () => {
    const geo = sparklineGeometry([0, 5, 10], OPTS)!;
    const pts = pointsOf(geo.line);
    expect(pts).toHaveLength(3);
    expect(pts[0]![0]).toBe(0);
    expect(pts[2]![0]).toBe(100);
    expect(geo.last.x).toBe(100);
  });

  it("puts a lone sample at the horizontal centre rather than at x=0", () => {
    // n===1 would divide by zero in the naive form, and 0/0 is NaN — which
    // silently invalidates the whole polyline.
    const geo = sparklineGeometry([7], OPTS)!;
    expect(pointsOf(geo.line)[0]![0]).toBe(50);
  });

  it("inverts y: the maximum sits above the minimum on screen", () => {
    const geo = sparklineGeometry([1, 9], OPTS)!;
    const [lo, hi] = pointsOf(geo.line);
    expect(hi![1]).toBeLessThan(lo![1]);
  });

  it("keeps the stroke inside the box, so the cap is not clipped", () => {
    const geo = sparklineGeometry([1, 9], OPTS)!;
    for (const [, y] of pointsOf(geo.line)) {
      expect(y).toBeGreaterThanOrEqual(OPTS.strokeWidth + 1);
      expect(y).toBeLessThanOrEqual(OPTS.height - OPTS.strokeWidth - 1);
    }
  });

  it("draws a flat series mid-box instead of dividing by a zero span", () => {
    const geo = sparklineGeometry([4, 4, 4], OPTS)!;
    for (const [, y] of pointsOf(geo.line)) expect(Number.isFinite(y)).toBe(true);
  });

  it("drops non-finite samples rather than poisoning min/max", () => {
    // One NaN in the series used to make every coordinate NaN — a blank chart
    // where the previous frame had a line, with nothing logged.
    const geo = sparklineGeometry([1, Number.NaN, 3, Number.POSITIVE_INFINITY], OPTS)!;
    const pts = pointsOf(geo.line);
    expect(pts).toHaveLength(2);
    expect(pts.flat().every(Number.isFinite)).toBe(true);
  });

  it("returns null when nothing in the series is finite", () => {
    expect(sparklineGeometry([Number.NaN, Number.NaN], OPTS)).toBeNull();
  });

  it("closes the area path on the baseline at both ends", () => {
    const geo = sparklineGeometry([2, 8], OPTS)!;
    expect(geo.area.startsWith(`M 0.00,${OPTS.height}`)).toBe(true);
    expect(geo.area.endsWith(`L 100.00,${OPTS.height} Z`)).toBe(true);
  });

  it("survives a series far longer than the argument-spread limit", () => {
    const many = Array.from({ length: 200_000 }, (_, i) => i);
    expect(() => sparklineGeometry(many, OPTS)).not.toThrow();
  });
});
