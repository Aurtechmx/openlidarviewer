/**
 * rasterizeDtm.test.ts — Phase A2 specs.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm, type DtmAggregation } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const ground = (pts: TerrainPoint[]) => new Uint8Array(pts.length).fill(1);

describe('rasterizeDtm', () => {
  it('averages multiple ground returns in a cell (mean)', () => {
    const pts: TerrainPoint[] = [
      { x: 0.1, y: 0.1, z: 2 },
      { x: 0.2, y: 0.2, z: 4 },
    ];
    const r = rasterizeDtm(pts, ground(pts), { cellSizeM: 1 });
    expect(r.cols).toBe(1);
    expect(r.rows).toBe(1);
    expect(r.z[0]).toBeCloseTo(3, 6);
    expect(r.counts[0]).toBe(2);
  });

  it('takes the lowest return with min aggregation', () => {
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 2 },
      { x: 0, y: 0, z: 4 },
    ];
    const r = rasterizeDtm(pts, ground(pts), { cellSizeM: 1, aggregation: 'min' });
    expect(r.z[0]).toBe(2);
  });

  it('leaves cells with no ground data as NaN with count 0', () => {
    // Two points 3 m apart → 4x1 grid with a gap in the middle.
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 1 },
      { x: 3, y: 0, z: 1 },
    ];
    const r = rasterizeDtm(pts, ground(pts), { cellSizeM: 1 });
    expect(r.cols).toBe(4);
    expect(r.counts[1]).toBe(0);
    expect(Number.isNaN(r.z[1])).toBe(true);
    expect(r.filledCellCount).toBe(2);
    expect(r.warnings.join(' ')).toMatch(/interpolation/i);
  });

  it('aligns to a supplied grid spec', () => {
    const pts: TerrainPoint[] = [{ x: 5, y: 5, z: 9 }];
    const r = rasterizeDtm(pts, ground(pts), {
      grid: { originH1: 0, originH2: 0, cols: 11, rows: 11, cellSizeM: 1 },
    });
    expect(r.cols).toBe(11);
    expect(r.z[5 * 11 + 5]).toBe(9);
  });

  it('ignores non-ground points via the mask', () => {
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 9 }, // non-ground
    ];
    const mask = new Uint8Array([1, 0]);
    const r = rasterizeDtm(pts, mask, { cellSizeM: 1 });
    expect(r.z[0]).toBe(0);
    expect(r.sourcePointCount).toBe(1);
  });

  it('skips non-finite ground returns and warns', () => {
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: Number.NaN, y: 0, z: 0 },
    ];
    const r = rasterizeDtm(pts, ground(pts), { cellSizeM: 1 });
    expect(r.analyzedPointCount).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/non-finite/i);
  });

  it('returns an empty raster when no ground returns exist', () => {
    const pts: TerrainPoint[] = [{ x: 0, y: 0, z: 0 }];
    const r = rasterizeDtm(pts, new Uint8Array([0]), { cellSizeM: 1 });
    expect(r.filledCellCount).toBe(0);
    expect(r.cols).toBe(0);
  });
});

describe('rasterizeDtm — robust cell aggregation', () => {
  // A single cell holding the four returns; all share one cell on a coarse grid.
  const oneCell = (zs: number[]): TerrainPoint[] =>
    zs.map((z, i) => ({ x: 0.1 * i, y: 0.1 * i, z }));
  const grid = { originH1: 0, originH2: 0, cols: 1, rows: 1, cellSizeM: 10 };

  describe('default is byte-identical to mean', () => {
    // Build a small multi-cell scene with uneven counts and run it through the
    // current default (no `aggregation`) and an EXPLICIT `mean`. They must be
    // bit-for-bit identical — proving omitting the option preserves behaviour.
    const pts: TerrainPoint[] = [
      { x: 0.1, y: 0.1, z: 2 },
      { x: 0.2, y: 0.2, z: 4 },
      { x: 0.3, y: 0.3, z: 9 },
      { x: 3.1, y: 0.1, z: 1 },
      { x: 3.2, y: 0.1, z: 7 },
      { x: 1.1, y: 2.1, z: 5 },
    ];
    const g = ground(pts);

    it('omitting aggregation equals explicit mean (z + counts identical)', () => {
      const def = rasterizeDtm(pts, g, { cellSizeM: 1 });
      const mean = rasterizeDtm(pts, g, { cellSizeM: 1, aggregation: 'mean' });
      expect(Array.from(def.z)).toEqual(Array.from(mean.z));
      expect(Array.from(def.counts)).toEqual(Array.from(mean.counts));
      expect(def.cols).toBe(mean.cols);
      expect(def.rows).toBe(mean.rows);
    });

    it('default reproduces the known mean fixture exactly', () => {
      // Snapshot of the current behaviour for a hand-checkable cell.
      const cellPts = oneCell([2, 4]); // mean = 3
      const r = rasterizeDtm(cellPts, ground(cellPts), { grid });
      expect(r.z[0]).toBe(3); // exact, not toBeCloseTo
      expect(r.counts[0]).toBe(2);
    });
  });

  describe('known-truth per mode on a hand-built cell [10,10,10,50]', () => {
    const zs = [10, 10, 10, 50];
    const pts = oneCell(zs);
    const g = ground(pts);
    const run = (aggregation: DtmAggregation, percentile?: number) =>
      rasterizeDtm(pts, g, { grid, aggregation, percentile }).z[0];

    it('mean is pulled by the high outlier (20)', () => {
      expect(run('mean')).toBeCloseTo(20, 9);
    });
    it('min takes the low value (10)', () => {
      expect(run('min')).toBe(10);
    });
    it('median rejects the high outlier (10)', () => {
      expect(run('median')).toBe(10);
    });
    it('p10 rejects the high outlier (≈10)', () => {
      expect(run('percentile', 0.1)).toBeCloseTo(10, 9);
    });
    it('robust rejects the high outlier (10)', () => {
      expect(run('robust')).toBe(10);
    });
  });

  describe('low-blunder cell [2,10,10,10]', () => {
    const zs = [2, 10, 10, 10];
    const pts = oneCell(zs);
    const g = ground(pts);
    const run = (aggregation: DtmAggregation) =>
      rasterizeDtm(pts, g, { grid, aggregation }).z[0];

    it('min is biased low by the blunder (2)', () => {
      expect(run('min')).toBe(2);
    });
    it('median ignores the low blunder (10)', () => {
      expect(run('median')).toBe(10);
    });
    it('robust ignores the low blunder (10)', () => {
      expect(run('robust')).toBe(10);
    });
  });

  describe('percentile p parameter is respected', () => {
    // Five distinct values so the order statistics are unambiguous.
    const zs = [1, 2, 3, 4, 5];
    const pts = oneCell(zs);
    const g = ground(pts);
    const p = (percentile: number) =>
      rasterizeDtm(pts, g, { grid, aggregation: 'percentile', percentile }).z[0];

    it('p=0 returns the minimum', () => {
      expect(p(0)).toBe(1);
    });
    it('p=1 returns the maximum', () => {
      expect(p(1)).toBe(5);
    });
    it('p=0.5 returns the median', () => {
      expect(p(0.5)).toBe(3);
      expect(p(0.5)).toBe(rasterizeDtm(pts, g, { grid, aggregation: 'median' }).z[0]);
    });
    it('interpolates between order statistics (p=0.25 → 2)', () => {
      expect(p(0.25)).toBeCloseTo(2, 9); // idx = 0.25*4 = 1 → exactly sorted[1] = 2
    });
    it('defaults to median when percentile omitted', () => {
      expect(rasterizeDtm(pts, g, { grid, aggregation: 'percentile' }).z[0]).toBe(3);
    });
    it('clamps out-of-range p (p=2 → max, p=-1 → min)', () => {
      expect(p(2)).toBe(5);
      expect(p(-1)).toBe(1);
    });
  });

  describe('honesty: empty cells stay no-data under every mode', () => {
    // Two points 3 m apart on a 1 m grid → middle cells empty.
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 1 },
      { x: 3, y: 0, z: 1 },
    ];
    const modes = ['mean', 'min', 'median', 'percentile', 'robust'] as const;
    for (const aggregation of modes) {
      it(`${aggregation} leaves the gap as NaN with count 0`, () => {
        const r = rasterizeDtm(pts, ground(pts), { cellSizeM: 1, aggregation });
        expect(r.cols).toBe(4);
        expect(r.counts[1]).toBe(0);
        expect(Number.isNaN(r.z[1])).toBe(true);
        expect(r.filledCellCount).toBe(2);
      });
    }
  });

  it('single-return cells return that value under every mode', () => {
    const pts: TerrainPoint[] = [{ x: 5, y: 5, z: 42 }];
    for (const aggregation of ['median', 'percentile', 'robust'] as const) {
      const r = rasterizeDtm(pts, ground(pts), {
        grid: { originH1: 0, originH2: 0, cols: 11, rows: 11, cellSizeM: 1 },
        aggregation,
      });
      expect(r.z[5 * 11 + 5]).toBe(42);
    }
  });
});
