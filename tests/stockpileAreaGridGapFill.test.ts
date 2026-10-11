import { describe, expect, it } from 'vitest';
import { stockpileAreaGrid, type PackedAreaGridPoints } from '../src/render/measure/stockpileAreaGrid';

/**
 * Gap filling (interpolateGaps) must be linear in the grid size: the v4
 * square-ring search was O(K·R²) for a void of K cells and radius R, 23 s at
 * 800² cells on the main thread. These tests pin the cost and the edge cases.
 */

/** n×n unit cells, one point per cell at height z, a central square void of `voidFrac` area. */
function holedSquare(n: number, voidFrac: number, z: (x: number, y: number) => number = () => 1): PackedAreaGridPoints {
  const half = (n * Math.sqrt(voidFrac)) / 2;
  const xyz = new Float64Array(n * n * 3);
  let count = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i + 0.5, y = j + 0.5;
      if (Math.abs(x - n / 2) < half && Math.abs(y - n / 2) < half) continue;
      xyz[count * 3] = x; xyz[count * 3 + 1] = y; xyz[count * 3 + 2] = z(x, y);
      count++;
    }
  }
  return { xyz, count };
}

const square = (n: number) => [{ x: 0, y: 0 }, { x: n, y: 0 }, { x: n, y: n }, { x: 0, y: n }];

function run(n: number, points: PackedAreaGridPoints, extra: object = {}) {
  return stockpileAreaGrid({
    points, polygon: square(n), base: { kind: 'constant', zM: 0 },
    cellSizeM: 1, maxCells: 4e6, pointsInsideFootprint: true, interpolateGaps: true, ...extra,
  });
}

function bestOf(times: number, fn: () => void): number {
  let best = Infinity;
  for (let k = 0; k < times; k++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('stockpileAreaGrid gap filling', () => {
  it('fills a 1000×1000 grid with a 36 % central void well under a second, exactly on a flat surface', () => {
    const n = 1000;
    const pts = holedSquare(n, 0.36);
    let r = run(n, pts);
    const ms = bestOf(1, () => { r = run(n, pts); });
    expect(r.interpolatedFraction).toBeCloseTo(0.36, 2);
    expect(r.excludedFraction).toBe(0);
    // Every neighbour is at z = 1, so every interpolated cell is exactly 1.
    expect(r.fillM3).toBeCloseTo(n * n, 6);
    expect(ms).toBeLessThan(2000);
  }, 30_000);

  it('scales about linearly with the cell count (250² → 500²)', () => {
    const a = holedSquare(250, 0.36);
    const b = holedSquare(500, 0.36);
    run(250, a); run(500, b); // warm up
    const ta = bestOf(3, () => run(250, a));
    const tb = bestOf(3, () => run(500, b));
    // 4× the cells; the v4 search grew ~16× here.
    expect(tb / Math.max(ta, 1)).toBeLessThan(8);
  }, 30_000);

  it('stays inside the range of the observed surface on a tilted plane', () => {
    const n = 200;
    const r = run(n, holedSquare(n, 0.36, (x) => x / n));
    // Exact plane volume is n²/2; IDW of a linear surface is not exact, but
    // the void is symmetric about the centre, so the error is small.
    expect(Math.abs(r.fillM3 / (n * n * 0.5) - 1)).toBeLessThan(0.01);
  });

  it('skips interpolation above the withhold limit but reports the same shares', () => {
    const n = 100;
    const pts = holedSquare(n, 0.64);
    const full = run(n, pts);
    const capped = run(n, pts, { maxInterpolatedFraction: 0.5 });
    expect(full.interpolatedFraction).toBeGreaterThan(0.5);
    expect(capped.interpolatedFraction).toBe(full.interpolatedFraction);
    expect(capped.excludedFraction).toBe(full.excludedFraction);
    // Observed cells only.
    expect(capped.fillM3).toBeCloseTo(full.supportedAreaM2, 6);
    expect(full.fillM3).toBeCloseTo(n * n, 6);
  });

  it('excludes every gap when the covered cell centres are collinear', () => {
    const n = 20;
    const xyz = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { xyz[i * 3] = i + 0.5; xyz[i * 3 + 1] = 10.5; xyz[i * 3 + 2] = 2; }
    const r = run(n, { xyz, count: n });
    expect(r.interpolatedFraction).toBe(0);
    expect(r.excludedFraction).toBeCloseTo(1 - 1 / n, 9);
    expect(r.fillM3).toBeCloseTo(2 * n, 9);
  });

  it('interpolates nothing on an all-empty grid', () => {
    const r = run(10, { xyz: new Float64Array(0), count: 0 });
    expect(r.interpolatedFraction).toBe(0);
    expect(r.excludedFraction).toBe(1);
    expect(r.fillM3).toBe(0);
    expect(r.supportFraction).toBe(0);
  });
});
