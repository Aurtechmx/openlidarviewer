/**
 * contourShapeStyle.test.ts — the SHAPE-style transform over stitched
 * contour polylines. Pins the historical default ('smooth' = Chaikin ×2),
 * proves the honesty gate (no style ever moves a low-confidence / gap vertex),
 * and exercises the Douglas–Peucker simplifier's honesty guards.
 */

import { describe, it, expect } from 'vitest';
import {
  applyContourShapeStyle,
  simplifyPolyline,
  CONTOUR_SHAPE_STYLES,
  defaultContourShapeStyle,
  contourShapeStyleLabel,
  type ContourShapeStyle,
} from '../src/terrain/contour/contourShapeStyle';
import { chaikinSmooth } from '../src/terrain/contour/smoothing';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex } from '../src/terrain/contour/stitchContours';

const v = (x: number, y: number, c = 90): ContourVertex => ({
  x,
  y,
  confidence: c,
  grade: gradeForConfidence(c),
});

const line = (vertices: ContourVertex[], closed = false): ContourPolyline => ({
  value: 7,
  vertices,
  closed,
});

/** A high-resolution, gently-wavy open line — many near-collinear vertices. */
function wavyLine(): ContourPolyline {
  const verts: ContourVertex[] = [];
  for (let i = 0; i <= 40; i++) verts.push(v(i, 0.2 * Math.sin(i / 3)));
  return line(verts);
}

const ALL_STYLES = CONTOUR_SHAPE_STYLES.map((s) => s.value);

describe('contourShapeStyle presets', () => {
  it('exposes the five presets with default smooth', () => {
    expect(ALL_STYLES).toEqual([
      'crisp',
      'smooth',
      'rounded',
      'generalized',
      'semi-geometric',
    ]);
    expect(defaultContourShapeStyle).toBe('smooth');
    expect(CONTOUR_SHAPE_STYLES.every((s) => s.label && s.description)).toBe(true);
    expect(contourShapeStyleLabel('semi-geometric')).toBe('Semi-geometric');
  });
});

describe('applyContourShapeStyle', () => {
  it('crisp is identity — no vertex moved, same count', () => {
    const poly = line([v(0, 0), v(1, 1), v(2, 0), v(3, 2)]);
    const [out] = applyContourShapeStyle([poly], 'crisp');
    expect(out.vertices.length).toBe(poly.vertices.length);
    out.vertices.forEach((p, i) => {
      expect(p.x).toBe(poly.vertices[i].x);
      expect(p.y).toBe(poly.vertices[i].y);
    });
  });

  it('smooth reproduces the historical default chaikinSmooth(poly,{iterations:2}) EXACTLY', () => {
    const poly = wavyLine();
    const [styled] = applyContourShapeStyle([poly], 'smooth');
    const expected = chaikinSmooth(poly, { iterations: 2 });
    // Also identical to the historical bare call (no params) — the live default.
    const legacy = chaikinSmooth(poly);
    expect(styled.vertices.length).toBe(expected.vertices.length);
    styled.vertices.forEach((p, i) => {
      expect(p.x).toBe(expected.vertices[i].x);
      expect(p.y).toBe(expected.vertices[i].y);
      expect(p.x).toBe(legacy.vertices[i].x);
      expect(p.y).toBe(legacy.vertices[i].y);
    });
  });

  it('rounded increases vertex count more than smooth', () => {
    const poly = line([v(0, 0), v(1, 1), v(2, 0), v(3, 1), v(4, 0), v(5, 1)]);
    const [smooth] = applyContourShapeStyle([poly], 'smooth');
    const [rounded] = applyContourShapeStyle([poly], 'rounded');
    expect(rounded.vertices.length).toBeGreaterThan(smooth.vertices.length);
  });

  it('generalized and semi-geometric reduce vertex count via simplify before smoothing', () => {
    const poly = wavyLine();
    const [smooth] = applyContourShapeStyle([poly], 'smooth', { cellSizeM: 1 });
    const [generalized] = applyContourShapeStyle([poly], 'generalized', { cellSizeM: 1 });
    const [semi] = applyContourShapeStyle([poly], 'semi-geometric', { cellSizeM: 1 });
    expect(generalized.vertices.length).toBeLessThan(smooth.vertices.length);
    expect(semi.vertices.length).toBeLessThan(smooth.vertices.length);
    // The stronger simplify (semi-geometric) yields the fewest vertices.
    expect(semi.vertices.length).toBeLessThanOrEqual(generalized.vertices.length);
  });

  it('honesty — a low-confidence/gap vertex keeps its EXACT coordinates under EVERY style', () => {
    const gap = v(5, 3, 10); // confidence 10 → gap
    const poly = line([v(0, 0), v(2, 1), v(4, 0.5), gap, v(6, 0.4), v(8, 1), v(10, 0)]);
    for (const style of ALL_STYLES as ContourShapeStyle[]) {
      const [out] = applyContourShapeStyle([poly], style, { cellSizeM: 1 });
      const survives = out.vertices.some(
        (p) => p.x === 5 && p.y === 3 && p.confidence === 10,
      );
      expect(survives, `style ${style} dropped/moved the gap vertex`).toBe(true);
    }
  });

  it('keeps closed loops closed and pins open endpoints under every style', () => {
    const open = wavyLine();
    const closed = line([v(0, 0), v(4, 0), v(4, 4), v(0, 4)], true);
    for (const style of ALL_STYLES as ContourShapeStyle[]) {
      const [o] = applyContourShapeStyle([open], style, { cellSizeM: 1 });
      expect(o.closed).toBe(false);
      // open endpoints pinned to the originals
      expect([o.vertices[0].x, o.vertices[0].y]).toEqual([0, open.vertices[0].y]);
      const last = o.vertices[o.vertices.length - 1];
      expect([last.x, last.y]).toEqual([40, open.vertices[open.vertices.length - 1].y]);
      const [c] = applyContourShapeStyle([closed], style, { cellSizeM: 1 });
      expect(c.closed).toBe(true);
    }
  });

  it('preserves grade on output vertices', () => {
    const poly = line([v(0, 0, 90), v(1, 1, 90), v(2, 0, 90)]);
    for (const style of ALL_STYLES as ContourShapeStyle[]) {
      const [out] = applyContourShapeStyle([poly], style, { cellSizeM: 1 });
      expect(out.vertices.every((p) => p.grade === gradeForConfidence(p.confidence))).toBe(true);
    }
  });
});

describe('simplifyPolyline', () => {
  it('removes collinear interior points but keeps endpoints', () => {
    const poly = line([v(0, 0), v(1, 0), v(2, 0), v(3, 0), v(4, 0)]);
    const out = simplifyPolyline(poly, 0.01);
    expect(out.vertices.length).toBe(2);
    expect([out.vertices[0].x, out.vertices[1].x]).toEqual([0, 4]);
  });

  it('keeps a vertex that deviates beyond epsilon', () => {
    const poly = line([v(0, 0), v(1, 0), v(2, 5), v(3, 0), v(4, 0)]);
    const out = simplifyPolyline(poly, 1);
    expect(out.vertices.some((p) => p.x === 2 && p.y === 5)).toBe(true);
  });

  it('preserves closure for a closed ring', () => {
    const poly = line([v(0, 0), v(1, 0), v(2, 0), v(2, 2), v(0, 2)], true);
    const out = simplifyPolyline(poly, 0.01);
    expect(out.closed).toBe(true);
    // The redundant midpoint on the bottom edge is gone; corners remain.
    expect(out.vertices.some((p) => p.x === 1 && p.y === 0)).toBe(false);
    expect(out.vertices.some((p) => p.x === 0 && p.y === 0)).toBe(true);
  });

  it('NEVER drops a low-confidence vertex', () => {
    const gap = v(2, 0, 10);
    const poly = line([v(0, 0), v(1, 0), gap, v(3, 0), v(4, 0)]);
    const out = simplifyPolyline(poly, 5); // huge epsilon would drop it if unguarded
    expect(out.vertices.some((p) => p.x === 2 && p.y === 0 && p.confidence === 10)).toBe(true);
  });

  it('NEVER drops a vertex adjacent to a grade transition', () => {
    // solid, solid, then a dashed run — the solid vertex bordering the
    // transition must survive even though it is otherwise collinear.
    const poly = line([v(0, 0, 90), v(1, 0, 90), v(2, 0, 50), v(3, 0, 50), v(4, 0, 50)]);
    const out = simplifyPolyline(poly, 5);
    // the last solid vertex (x=1) borders the solid→dashed transition
    expect(out.vertices.some((p) => p.x === 1 && p.confidence === 90)).toBe(true);
    // the first dashed vertex (x=2) is below the floor → kept
    expect(out.vertices.some((p) => p.x === 2 && p.confidence === 50)).toBe(true);
  });

  it('returns short polylines and non-positive epsilon unchanged', () => {
    const two = line([v(0, 0), v(1, 1)]);
    expect(simplifyPolyline(two, 1).vertices.length).toBe(2);
    const poly = line([v(0, 0), v(1, 0), v(2, 0)]);
    expect(simplifyPolyline(poly, 0).vertices.length).toBe(3);
  });
});
