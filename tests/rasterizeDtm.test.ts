/**
 * rasterizeDtm.test.ts — Phase A2 specs.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
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
