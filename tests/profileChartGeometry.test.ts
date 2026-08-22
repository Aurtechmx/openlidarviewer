/**
 * profileChartGeometry.test.ts
 *
 * End-to-end geometry check on the profile chart the Measurements panel
 * actually renders. `tests/profilePath.test.ts` pins the path builder in
 * isolation; this test mounts `MeasurePanel`, reads the chart markup the panel
 * put in `innerHTML`, and applies the same bound to the emitted `d`.
 *
 * THE CONTRACT: between two adjacent samples the drawn line stays within the
 * range of those two samples, after the panel's own elevation mapping. The
 * bound is checked against the path's own vertices, so it holds at any
 * vertical exaggeration or chart size.
 *
 * The fixture is the four-sample plateau [0, 1, 1, 0]. Under the previous
 * Catmull-Rom renderer the emitted chart path reached y = -16.25 against a
 * plot top edge of y = 16: 32.25 px of elevation the corridor never reported,
 * drawn between two stations at the same height.
 *
 * The panel is mounted against a recording node stub, the same approach the
 * other MeasurePanel tests use. The chart markup is a string the stub stores
 * verbatim, which is exactly what this test needs to read.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { installFakeDom, type FakeEl } from './support/measurePanelDom';

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

beforeAll(installFakeDom);

/** Four samples at 10 m spacing: a low end, a two-station plateau, a low end. */
const PLATEAU_HEIGHTS = [0, 1, 1, 0] as const;
/** A flat run of zeros next to a single step up. */
const FLAT_THEN_STEP = [0, 0, 0, 1] as const;

function profileRow(heights: readonly number[]): MeasurementSummary {
  const profileChart: ProfileChartSample[] = heights.map((height, i) => ({
    distance: i * 10,
    height,
    count: 12,
  }));
  return {
    id: 'p1',
    kind: 'profile',
    name: 'Section A',
    value: '30.00 m',
    profileChart,
  };
}

/** Mount the panel and return the `d` of every profile path it drew. */
function chartPaths(heights: readonly number[]): string[] {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.update([profileRow(heights)]);
  const root = panel.element as unknown as FakeEl;
  const chart = root.querySelector('div.olv-mp-chart');
  expect(chart).not.toBeNull();
  const ds = [...chart!.innerHTML.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  expect(ds.length).toBeGreaterThan(0);
  return ds;
}

interface Pt {
  readonly x: number;
  readonly y: number;
}

const STEPS = 1000;

/**
 * Walk one emitted path and assert that no point drawn between two vertices
 * leaves the closed interval those two vertices span. `C` is parsed and
 * sampled along the Bezier, so a spline renderer is measured on its real
 * geometry rather than rejected at parse time. Returns every drawn y.
 */
function boundedYs(d: string): number[] {
  const toks = d.replace(/([MLC])/g, ' $1 ').trim().split(/[\s,]+/);
  const ys: number[] = [];
  let i = 0;
  let cur: Pt = { x: 0, y: 0 };
  const num = (): number => {
    const v = Number(toks[i++]);
    expect(Number.isFinite(v)).toBe(true);
    return v;
  };
  const check = (from: Pt, to: Pt, at: (t: number) => number): void => {
    const lo = Math.min(from.y, to.y);
    const hi = Math.max(from.y, to.y);
    for (let s = 1; s < STEPS; s++) {
      const y = at(s / STEPS);
      ys.push(y);
      expect(y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(y).toBeLessThanOrEqual(hi + 1e-9);
    }
  };
  while (i < toks.length) {
    const cmd = toks[i++];
    if (cmd === 'M') {
      cur = { x: num(), y: num() };
      ys.push(cur.y);
    } else if (cmd === 'L') {
      const to = { x: num(), y: num() };
      check(cur, to, (t) => cur.y + (to.y - cur.y) * t);
      ys.push(to.y);
      cur = to;
    } else if (cmd === 'C') {
      const c1 = { x: num(), y: num() };
      const c2 = { x: num(), y: num() };
      const to = { x: num(), y: num() };
      check(cur, to, (t) => {
        const u = 1 - t;
        return u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y;
      });
      ys.push(to.y);
      cur = to;
    } else {
      throw new Error(`unsupported path command ${cmd}`);
    }
  }
  return ys;
}

describe('MeasurePanel profile chart — drawn geometry stays inside the samples', () => {
  it('draws the plateau [0, 1, 1, 0] without rising above the plateau stations', () => {
    const ds = chartPaths(PLATEAU_HEIGHTS);
    expect(ds).toHaveLength(1);
    const ys = boundedYs(ds[0]);
    // SVG y grows downward, so the plateau maps to the SMALLEST y. The plot top
    // edge is 16 in the chart viewBox; the old spline reached -16.25 here.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(16);
  });

  it('draws a flat run of zeros without dipping below it', () => {
    const ds = chartPaths(FLAT_THEN_STEP);
    // The flat run maps to the LARGEST y; the plot bottom edge is 274.
    expect(Math.max(...boundedYs(ds[0]))).toBeLessThanOrEqual(274);
  });

  it('breaks the line at a coverage gap instead of bridging it', () => {
    // A non-finite sample ends a run, so two runs means two separate paths.
    const ds = chartPaths([0, 1, Number.NaN, 1, 0]);
    expect(ds).toHaveLength(2);
    for (const d of ds) boundedYs(d);
  });
});
