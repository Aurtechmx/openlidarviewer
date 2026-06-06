/**
 * terrainTruth.dtm.test.ts — known-truth DTM rasterisation specs.
 *
 * Asserts EXPECTED NUMERIC elevations (within tolerance) against the
 * analytic surfaces produced by tests/fixtures/terrainScenes.ts, not just
 * "a grid exists". Tests rasterizeDtm / buildDtmGrid directly for crisp
 * truth (no ground-filter heuristics in the loop).
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import {
  flatPlane,
  uniformSlope,
  gaussianHill,
  pit,
  ridge,
  valley,
  sparse,
  edgeClipped,
  allGround,
  gridFor,
} from './fixtures/terrainScenes';

const EXTENT = { nx: 24, ny: 24, spacing: 1 } as const;
const grid = gridFor(EXTENT);

/** Indices of cells strictly inside a 1-cell border. */
function interiorIndices(cols: number, rows: number): number[] {
  const out: number[] = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) out.push(r * cols + c);
  }
  return out;
}

describe('DTM truth — flat plane', () => {
  it('every covered cell equals z0 (tight tolerance)', () => {
    const z0 = 42.5;
    const pts = flatPlane(z0, EXTENT);
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    // node-per-cell -> every cell covered
    expect(r.filledCellCount).toBe(grid.cols * grid.rows);
    for (let i = 0; i < r.z.length; i++) {
      expect(r.z[i]).toBeCloseTo(z0, 6);
    }
  });
});

describe('DTM truth — uniform slope matches the analytic plane', () => {
  it('axis x: each cell = z0 + gradient * (node x)', () => {
    const gradient = 0.4;
    const z0 = 10;
    const pts = uniformSlope({ ...EXTENT, gradient, axis: 'x', z0 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    // Each cell (col,row) holds the single node at x = col*cell.
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const expected = z0 + gradient * (col * grid.cellSizeM);
        expect(r.z[row * grid.cols + col]).toBeCloseTo(expected, 4);
      }
    }
  });

  it('axis y: each cell = z0 + gradient * (node y)', () => {
    const gradient = 0.25;
    const pts = uniformSlope({ ...EXTENT, gradient, axis: 'y', z0: 0 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    for (let row = 0; row < grid.rows; row++) {
      const expected = gradient * (row * grid.cellSizeM);
      expect(r.z[row * grid.cols + 0]).toBeCloseTo(expected, 4);
    }
  });
});

describe('DTM truth — extrema located at the expected cells', () => {
  it('gaussian hill: global max is the centre cell', () => {
    const pts = gaussianHill({ ...EXTENT, amplitude: 8 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    let maxI = 0;
    for (let i = 1; i < r.z.length; i++) if (r.z[i] > r.z[maxI]) maxI = i;
    const col = maxI % grid.cols;
    const row = (maxI - col) / grid.cols;
    // centre node index of a 24-wide grid is col/row in {11,12}
    expect(Math.abs(col - (grid.cols - 1) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(row - (grid.rows - 1) / 2)).toBeLessThanOrEqual(1);
    // No node sits exactly on the continuous centre of an even grid, so the
    // sampled peak is slightly below the amplitude (8) but very near it.
    expect(r.z[maxI]).toBeGreaterThan(7.9);
    expect(r.z[maxI]).toBeLessThanOrEqual(8);
  });

  it('pit: global min is the centre cell, ~ -depth', () => {
    const pts = pit({ ...EXTENT, depth: 8 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    let minI = 0;
    for (let i = 1; i < r.z.length; i++) if (r.z[i] < r.z[minI]) minI = i;
    const col = minI % grid.cols;
    const row = (minI - col) / grid.cols;
    expect(Math.abs(col - (grid.cols - 1) / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(row - (grid.rows - 1) / 2)).toBeLessThanOrEqual(1);
    expect(r.z[minI]).toBeLessThan(-7.9);
    expect(r.z[minI]).toBeGreaterThanOrEqual(-8);
  });

  it('ridge: max lies on the mid crest column, every row', () => {
    const pts = ridge({ ...EXTENT, axis: 'y', amplitude: 6 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    const midCol = Math.round((grid.cols - 1) / 2);
    for (let row = 0; row < grid.rows; row++) {
      let bestCol = 0;
      for (let c = 1; c < grid.cols; c++) {
        if (r.z[row * grid.cols + c] > r.z[row * grid.cols + bestCol]) bestCol = c;
      }
      expect(Math.abs(bestCol - midCol)).toBeLessThanOrEqual(1);
    }
  });

  it('valley: min lies on the mid trough column, every row', () => {
    const pts = valley({ ...EXTENT, axis: 'y', amplitude: 6 });
    const r = rasterizeDtm(pts, allGround(pts), { grid });
    const midCol = Math.round((grid.cols - 1) / 2);
    for (let row = 0; row < grid.rows; row++) {
      let bestCol = 0;
      for (let c = 1; c < grid.cols; c++) {
        if (r.z[row * grid.cols + c] < r.z[row * grid.cols + bestCol]) bestCol = c;
      }
      expect(Math.abs(bestCol - midCol)).toBeLessThanOrEqual(1);
    }
  });
});

describe('DTM truth — confidence-aware grid keeps measured cells honest', () => {
  it('flat plane: every cell measured, equals z0, with the documented confidence', () => {
    const z0 = 5;
    const pts = flatPlane(z0, EXTENT);
    const raster = rasterizeDtm(pts, allGround(pts), { grid });
    // Default model: one return/cell -> relative=count/median=1, absolute=
    // count/(count+absoluteHalfCount)=1/(1+3)=0.25 -> confidence=round(100*0.25)=25.
    const g = buildDtmGrid(raster, { crs: 'EPSG:32610' });
    for (const i of interiorIndices(g.cols, g.rows)) {
      expect(g.coverage[i]).toBe(2); // measured
      expect(g.z[i]).toBeCloseTo(z0, 6);
      expect(g.confidence[i]).toBe(25);
    }
    // Disabling the absolute floor (relative-only) -> full density confidence.
    const gRel = buildDtmGrid(raster, { crs: 'EPSG:32610', absoluteHalfCount: 0 });
    for (const i of interiorIndices(gRel.cols, gRel.rows)) {
      expect(gRel.confidence[i]).toBe(100);
    }
  });
});

describe('DTM truth — sparse & edge-clipped never fabricate the missing side', () => {
  it('sparse: sampled cells read z0; gaps are interpolated or empty, not arbitrary', () => {
    const z0 = 20;
    const pts = sparse(z0, 3, EXTENT); // every 3rd node
    const raster = rasterizeDtm(pts, allGround(pts), { grid });
    // measured cells must equal z0 exactly
    for (let i = 0; i < raster.z.length; i++) {
      if (raster.counts[i] > 0) expect(raster.z[i]).toBeCloseTo(z0, 6);
    }
    // and there genuinely are empty cells
    expect(raster.filledCellCount).toBeLessThan(grid.cols * grid.rows);
    // Interpolating a flat field still yields z0 (IDW of equal values),
    // and the honest grid must not invent a different height.
    const g = buildDtmGrid(raster, { crs: 'EPSG:32610' });
    for (let i = 0; i < g.z.length; i++) {
      if (g.coverage[i] > 0) expect(g.z[i]).toBeCloseTo(z0, 4);
    }
  });

  it('edge-clipped: covered half reads z0; clipped half is never confidently filled to z0+', () => {
    const z0 = 7;
    const pts = edgeClipped(z0, 0.5, EXTENT);
    const raster = rasterizeDtm(pts, allGround(pts), { grid });
    const keepCols = Math.floor(grid.cols * 0.5);
    // Left (covered) cells measured and equal to z0.
    for (let row = 0; row < grid.rows; row++) {
      for (let c = 0; c < keepCols; c++) {
        const i = row * grid.cols + c;
        expect(raster.counts[i]).toBeGreaterThan(0);
        expect(raster.z[i]).toBeCloseTo(z0, 6);
      }
    }
    // Right (clipped) cells received NO ground returns — honest no-data.
    for (let row = 0; row < grid.rows; row++) {
      for (let c = keepCols; c < grid.cols; c++) {
        const i = row * grid.cols + c;
        expect(raster.counts[i]).toBe(0);
        expect(Number.isNaN(raster.z[i])).toBe(true);
      }
    }
    // With an extrapolation guard + max-interp-distance, the far clipped
    // edge must NOT be fabricated as a confident measured surface.
    const g = buildDtmGrid(raster, {
      crs: 'EPSG:32610',
      maxInterpDistanceCells: 2,
      extrapolationGuard: { dropSingleDirection: true },
    });
    const farCol = grid.cols - 1;
    for (let row = 0; row < grid.rows; row++) {
      const i = row * grid.cols + farCol;
      // far clipped column is a genuine gap (coverage 0) under hardening
      expect(g.coverage[i]).toBe(0);
      expect(g.confidence[i]).toBe(0);
    }
  });
});
