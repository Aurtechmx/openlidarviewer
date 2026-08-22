/**
 * profilePath.test.ts
 *
 * Geometry contract for the terrain-profile line renderer shared by the panel
 * chart and the profile PDF (`src/render/measure/profilePath.ts`).
 *
 * THE CONTRACT: between two adjacent samples the drawn line stays within the
 * range of those two samples. A reader who takes a height off the chart at a
 * point between two stations reads a value the corridor could have reported.
 *
 * The assertions sample the EMITTED PATH STRING densely rather than reading the
 * control points, so a renderer that emits vertices on the data and geometry
 * off it is caught. The parser accepts cubic segments (`C`) as well as lines,
 * so reintroducing a spline fails on the bound, not on a parse error.
 *
 * MEASURED PRIOR BEHAVIOUR. The previous renderer was a uniform Catmull-Rom
 * spline emitted as cubic Beziers. Evaluated on its own emitted path:
 *   - samples [0, 1, 1, 0] reached y = 1.1275 between two stations that both
 *     read exactly 1;
 *   - samples [0, 0, 0, 1] reached y = -0.0756 inside a run of zeros;
 *   - at the chart's pixel scale a plateau at the top of the band reached
 *     y = -16.25 against a plot top edge of y = 16.
 * Those fixtures are kept below as the regression cases.
 */

import { describe, it, expect } from 'vitest';

import { profilePolylinePath } from '../src/render/measure/profilePath';

interface Pt {
  readonly x: number;
  readonly y: number;
}

/** One parsed segment: its two endpoints and every point drawn between them. */
interface Segment {
  readonly from: Pt;
  readonly to: Pt;
  readonly interior: Pt[];
}

const STEPS = 2000;

/**
 * Parse an emitted path into segments and sample each one densely.
 *
 * Supports the `M` / `L` / `C` subset. `C` is supported on purpose: a cubic
 * segment is sampled along the Bezier so a spline renderer is measured, not
 * rejected.
 */
function segmentsOf(d: string, steps = STEPS): Segment[] {
  if (d === '') return [];
  const toks = d.replace(/([MLC])/g, ' $1 ').trim().split(/[\s,]+/);
  const out: Segment[] = [];
  let i = 0;
  let cur: Pt = { x: 0, y: 0 };
  const num = (): number => {
    const v = Number(toks[i++]);
    if (!Number.isFinite(v)) throw new Error(`non-numeric path token at ${i - 1}`);
    return v;
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === 'M') {
      cur = { x: num(), y: num() };
      continue;
    }
    if (cmd === 'L') {
      const to = { x: num(), y: num() };
      const interior: Pt[] = [];
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        interior.push({ x: cur.x + (to.x - cur.x) * t, y: cur.y + (to.y - cur.y) * t });
      }
      out.push({ from: cur, to, interior });
      cur = to;
      continue;
    }
    if (cmd === 'C') {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const to = { x: num(), y: num() };
      const interior: Pt[] = [];
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        interior.push({
          x: u * u * u * cur.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x,
          y: u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y,
        });
      }
      out.push({ from: cur, to, interior });
      cur = to;
      continue;
    }
    throw new Error(`unsupported path command ${cmd}`);
  }
  return out;
}

/** Every drawn y across the whole path, endpoints included. */
function allY(d: string): number[] {
  const segs = segmentsOf(d);
  const ys: number[] = [];
  for (const s of segs) {
    ys.push(s.from.y, s.to.y);
    for (const p of s.interior) ys.push(p.y);
  }
  return ys;
}

/**
 * Assert the per-segment bound: no point drawn between two samples leaves the
 * closed interval those two samples span. The tolerance covers the two-decimal
 * rounding the builder applies to each emitted coordinate.
 */
function expectSegmentBounded(d: string): void {
  const segs = segmentsOf(d);
  expect(segs.length).toBeGreaterThan(0);
  for (const seg of segs) {
    const lo = Math.min(seg.from.y, seg.to.y);
    const hi = Math.max(seg.from.y, seg.to.y);
    for (const p of seg.interior) {
      expect(p.y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(p.y).toBeLessThanOrEqual(hi + 1e-9);
    }
  }
}

/** Build points from a height series on a unit station spacing. */
const series = (heights: readonly number[]): Pt[] =>
  heights.map((y, i) => ({ x: i, y }));

/** The four-sample plateau: two interior stations at exactly the same height. */
const PLATEAU = [0, 1, 1, 0] as const;
/** A flat run of zeros next to a step up. */
const FLAT_THEN_STEP = [0, 0, 0, 1] as const;
/**
 * Chart-space plateau: the same four samples after the panel's mapping at
 * vertical exaggeration 1, plot top edge y = 16, plot bottom edge y = 274
 * (SVG y grows downward, so the plateau is the SMALLEST y).
 */
const PLATEAU_CHART: Pt[] = [
  { x: 30, y: 274 },
  { x: 85.33, y: 16 },
  { x: 140.67, y: 16 },
  { x: 196, y: 274 },
];

describe('profilePolylinePath — drawn heights stay inside the data', () => {
  it('holds the plateau [0, 1, 1, 0] at 1, never the spline peak of 1.1275', () => {
    const d = profilePolylinePath(series(PLATEAU));
    const ys = allY(d);
    expect(Math.max(...ys)).toBeLessThanOrEqual(1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expectSegmentBounded(d);
  });

  it('keeps a flat run of zeros at zero, never the spline dip of -0.0756', () => {
    const d = profilePolylinePath(series(FLAT_THEN_STEP));
    expect(Math.min(...allY(d))).toBeGreaterThanOrEqual(0);
    expectSegmentBounded(d);
  });

  it('keeps a chart-space plateau off the plot top edge', () => {
    const d = profilePolylinePath(PLATEAU_CHART);
    // The old spline reached y = -16.25 here, 32.25 px above the plateau.
    expect(Math.min(...allY(d))).toBeGreaterThanOrEqual(16);
    expect(Math.max(...allY(d))).toBeLessThanOrEqual(274);
    expectSegmentBounded(d);
  });

  it('bounds every segment of a long fixed relief series', () => {
    // A deterministic series with plateaus, single-sample spikes, reversals and
    // sub-unit steps: the shapes a spline overshoots on. No generated values.
    const heights = [
      12.0, 12.0, 12.0, 12.4, 18.9, 18.9, 4.2, 4.2, 4.2, 4.25, 4.3, 30.1, 30.1,
      29.9, 0.0, 0.0, 0.0, 0.0, 7.7, 7.7, 7.65, 7.7, 100.0, 99.5, 99.5, 0.5,
      0.5, 0.5, 0.5, 51.25,
    ];
    const d = profilePolylinePath(series(heights));
    expectSegmentBounded(d);
    // And the global bound follows from the per-segment one.
    const ys = allY(d);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(Math.min(...heights));
    expect(Math.max(...ys)).toBeLessThanOrEqual(Math.max(...heights));
  });

  it('emits straight segments only', () => {
    const d = profilePolylinePath(series(PLATEAU));
    expect(d).not.toMatch(/[CcSsQqTtAa]/);
    expect(d).toBe('M 0.00 0.00 L 1.00 1.00 L 2.00 1.00 L 3.00 0.00');
  });

  it('handles empty, single-point and two-point runs', () => {
    expect(profilePolylinePath([])).toBe('');
    expect(profilePolylinePath([{ x: 1.5, y: 2.5 }])).toBe('M 1.50 2.50');
    expect(profilePolylinePath([{ x: 0, y: 0 }, { x: 4, y: 9 }])).toBe(
      'M 0.00 0.00 L 4.00 9.00',
    );
  });
});
