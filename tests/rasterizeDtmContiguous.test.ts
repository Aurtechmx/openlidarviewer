import { describe, it, expect } from 'vitest';
import { rasterizeDtm, type DtmAggregation } from '../src/terrain/ground/rasterizeDtm';
import { quantileSorted } from '../src/terrain/quantile';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/**
 * The list-needing aggregations (median, percentile, robust) used to keep one
 * JavaScript array per filled cell and sort each. They now lay every return
 * out in one buffer by cell. The reduction is the same arithmetic over the
 * same sorted values, so the raster must be byte-identical to what the
 * per-cell arrays produced. The reference below is that earlier reduction,
 * kept here in full so the comparison does not depend on the module under
 * test for anything but the grid it is handed.
 */

function cloud(n: number, seed: number, dupEvery: number): TerrainPoint[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const pts: TerrainPoint[] = [];
  for (let i = 0; i < n; i++) {
    const p = { x: rnd() * 40 - 2, y: rnd() * 30 - 1, z: 100 + rnd() * 20 + (rnd() < 0.1 ? 15 : 0) };
    pts.push(p);
    if (dupEvery > 0 && i % dupEvery === 0) pts.push({ ...p });
  }
  pts.push({ x: 3, y: 3, z: Number.NaN });
  pts.push({ x: Number.POSITIVE_INFINITY, y: 3, z: 100 });
  return pts;
}

function shuffled<T>(a: readonly T[], seed: number): T[] {
  const out = a.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (1664525 * s + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const grid = { originH1: 0, originH2: 0, cols: 37, rows: 29, cellSizeM: 1 };

/** The per-cell-array reduction rasterizeDtm carried before, same binning. */
function reference(pts: readonly TerrainPoint[], aggregation: DtmAggregation, percentile: number): Float32Array {
  const { originH1, originH2, cols, rows, cellSizeM } = grid;
  const nCells = cols * rows;
  const lists: Array<number[] | undefined> = new Array(nCells);
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    const fx = (p.x - originH1) / cellSizeM;
    const fy = (p.y - originH2) / cellSizeM;
    if (fx < -1e-6 || fx > cols + 1e-6 || fy < -1e-6 || fy > rows + 1e-6) continue;
    const col = Math.min(cols - 1, Math.max(0, Math.floor(fx)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
    const c = row * cols + col;
    (lists[c] ??= []).push(p.z);
  }
  const z = new Float32Array(nCells).fill(Number.NaN);
  for (let c = 0; c < nCells; c++) {
    const list = lists[c];
    if (!list || list.length === 0) continue;
    list.sort((a, b) => a - b);
    if (aggregation === 'median') z[c] = quantileSorted(list, 0.5);
    else if (aggregation === 'percentile') z[c] = quantileSorted(list, percentile);
    else z[c] = robustReference(list);
  }
  return z;
}

function robustReference(sorted: number[]): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const m = quantileSorted(sorted, 0.5);
  const dev = sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
  const sigma = 1.4826 * quantileSorted(dev, 0.5);
  let sum = 0;
  let kept = 0;
  for (const v of sorted) if (Math.abs(v - m) <= 3 * sigma) { sum += v; kept++; }
  return kept > 0 ? sum / kept : m;
}

const bytes = (a: Float32Array): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

describe('rasterizeDtm: contiguous cell storage is byte-identical to per-cell arrays', () => {
  const cases: Array<[DtmAggregation, number]> = [
    ['median', 0.5], ['percentile', 0], ['percentile', 0.1], ['percentile', 0.5], ['percentile', 0.9], ['percentile', 1], ['robust', 0.5],
  ];

  it('matches on random clouds with duplicates, non-finite returns and outside points, in any order', () => {
    for (const [aggregation, percentile] of cases) {
      for (const seed of [1, 7, 42]) {
        const pts = cloud(4000, seed, 9);
        for (const order of [pts, shuffled(pts, seed * 3)]) {
          const mask = new Uint8Array(order.length).fill(1);
          const out = rasterizeDtm(order, mask, { grid, aggregation, percentile });
          const ref = reference(order, aggregation, percentile);
          expect(Buffer.compare(bytes(out.z), bytes(ref)), `${aggregation} p=${percentile} seed=${seed}`).toBe(0);
          expect(out.outsideGridPointCount).toBeGreaterThan(0);
        }
      }
    }
  });

  it('keeps odd and even cell counts, one-return cells and a single dense cell exact', () => {
    const pts: TerrainPoint[] = [];
    for (let k = 0; k < 7; k++) pts.push({ x: 0.5, y: 0.5, z: 100 + k });      // odd
    for (let k = 0; k < 8; k++) pts.push({ x: 1.5, y: 0.5, z: 200 - k * 0.25 }); // even
    pts.push({ x: 2.5, y: 0.5, z: 7 });                                          // single
    for (let k = 0; k < 5000; k++) pts.push({ x: 3.5, y: 0.5, z: 50 + (k % 13) }); // dense, ties
    const mask = new Uint8Array(pts.length).fill(1);
    for (const [aggregation, percentile] of cases) {
      const out = rasterizeDtm(pts, mask, { grid, aggregation, percentile });
      const ref = reference(pts, aggregation, percentile);
      expect(Buffer.compare(bytes(out.z), bytes(ref)), `${aggregation} p=${percentile}`).toBe(0);
      expect(out.counts[0]).toBe(7);
      expect(out.counts[1]).toBe(8);
      expect(out.counts[2]).toBe(1);
      expect(out.counts[3]).toBe(5000);
    }
  });

  it('leaves the O(1)-state modes untouched by the change', () => {
    const pts = cloud(2000, 5, 0);
    const mask = new Uint8Array(pts.length).fill(1);
    const mean = rasterizeDtm(pts, mask, { grid, aggregation: 'mean' });
    const min = rasterizeDtm(pts, mask, { grid, aggregation: 'min' });
    const median = rasterizeDtm(pts, mask, { grid, aggregation: 'median' });
    expect(Buffer.compare(bytes(mean.counts as unknown as Float32Array), bytes(median.counts as unknown as Float32Array))).toBe(0);
    expect(min.filledCellCount).toBe(median.filledCellCount);
    expect(Array.from(min.z).every((v, i) => Number.isNaN(v) || v <= median.z[i] + 1e-6)).toBe(true);
  });
});
