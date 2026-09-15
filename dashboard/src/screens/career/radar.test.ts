/**
 * The radar's geometry. Same argument as the sparkline's: a broken path does
 * not throw and does not log — it draws a shape that is not the data, on the
 * one panel meant to show where you are weakest.
 */
import { describe, expect, it } from "vitest";
import { LEVEL_VALUE, LEVELS, pointOn, radarModel } from "./radar";

const layer = (id: string, proficiency: "none" | "learning" | "working" | "solid" = "none") => ({
  id,
  name: id.toUpperCase(),
  proficiency,
});

describe("pointOn", () => {
  it("puts axis 0 straight up", () => {
    const [x, y] = pointOn(0, 4, 1);
    expect(x).toBeCloseTo(130, 6);
    expect(y).toBeCloseTo(38, 6); // centre 130 − radius 92
  });

  it("walks clockwise", () => {
    // Axis 1 of 4 is due right in SVG coordinates (y grows downward).
    const [x, y] = pointOn(1, 4, 1);
    expect(x).toBeCloseTo(222, 6);
    expect(y).toBeCloseTo(130, 6);
  });

  it("collapses to the centre at f = 0", () => {
    expect(pointOn(2, 5, 0)).toEqual([130, 130]);
  });
});

describe("radarModel", () => {
  it("refuses fewer than three axes rather than drawing a line", () => {
    expect(radarModel([])).toBeNull();
    expect(radarModel([layer("a")])).toBeNull();
    expect(radarModel([layer("a"), layer("b")])).toBeNull();
    expect(radarModel([layer("a"), layer("b"), layer("c")])).not.toBeNull();
  });

  it("orders axes by id so two devices draw the same shape", () => {
    const layers = [layer("c", "solid"), layer("a", "none"), layer("b", "working")];
    const m = radarModel(layers)!;
    expect(m.vertices.map((v) => v.id)).toEqual(["a", "b", "c"]);
    // Reversed input, identical polygon — the property that matters, since
    // per-record sync rebuilds the array in id order on every pull.
    expect(radarModel([...layers].reverse())!.polygon).toBe(m.polygon);
  });

  it("collapses a 'none' vertex onto the centre", () => {
    const m = radarModel([layer("a"), layer("b"), layer("c")])!;
    for (const v of m.vertices) {
      expect(v.vx).toBeCloseTo(m.centre, 6);
      expect(v.vy).toBeCloseTo(m.centre, 6);
    }
  });

  it("puts a 'solid' vertex on the outer ring", () => {
    const m = radarModel([layer("a", "solid"), layer("b"), layer("c")])!;
    const top = m.vertices[0]!;
    expect(top.vx).toBeCloseTo(130, 6);
    expect(top.vy).toBeCloseTo(38, 6);
    expect(m.axes[0]).toEqual({ x: top.vx, y: top.vy });
  });

  it("emits three closed rings and one closed polygon", () => {
    const m = radarModel([layer("a"), layer("b"), layer("c"), layer("d")])!;
    expect(m.rings).toHaveLength(3);
    for (const r of m.rings) {
      expect(r.startsWith("M")).toBe(true);
      expect(r.endsWith(" Z")).toBe(true);
      // One move plus three lines for four axes.
      expect(r.split("L")).toHaveLength(4);
    }
    expect(m.polygon.endsWith(" Z")).toBe(true);
  });

  it("anchors labels away from the chart", () => {
    const m = radarModel([layer("top"), layer("right"), layer("bottom"), layer("left")])!;
    expect(m.vertices.map((v) => v.anchor)).toEqual(["middle", "start", "middle", "end"]);
  });

  it("keeps labels outside the outer ring", () => {
    const m = radarModel([layer("a"), layer("b"), layer("c")])!;
    for (const v of m.vertices) {
      const d = Math.hypot(v.lx - m.centre, v.ly - m.centre);
      expect(d).toBeGreaterThan(92);
    }
  });

  it("gives a hit radius big enough for a thumb", () => {
    // 3.5 user units was the dot's own radius in the source, and it was also
    // the whole target. Anything under ~18 units is not tappable here.
    expect(radarModel([layer("a"), layer("b"), layer("c")])!.hit).toBeGreaterThanOrEqual(18);
  });
});

describe("proficiency scale", () => {
  it("is ordinal and ascending", () => {
    expect(LEVELS.map((l) => LEVEL_VALUE[l])).toEqual([0, 1, 2, 3]);
  });
});
