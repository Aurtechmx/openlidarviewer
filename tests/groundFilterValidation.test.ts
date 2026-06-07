/**
 * groundFilterValidation.test.ts
 *
 * Known-truth VALIDATION of the SMRF ground classifier against scenes
 * with analytically known geometry (tests/fixtures/terrainScenes.ts).
 * Unlike groundFilter.test.ts (which pins recall/precision on a small
 * hand-built scene and the morphology helpers), this suite asserts two
 * end-to-end accuracy properties that downstream contour quality depends
 * on:
 *
 *   1. Ground RECOVERY — on a clean bare-earth surface with a building
 *      (class 6) and canopy (class 5) overlay, SMRF must recall the vast
 *      majority of true-ground returns AND reject the vast majority of
 *      non-ground returns (no silent leakage of rooftops / treetops into
 *      "ground").
 *   2. SURFACE ACCURACY — the DTM built from the classified ground must
 *      match the KNOWN analytic surface to a tight tolerance on interior
 *      cells (the 1-cell border is excluded; opening + edge effects are
 *      least trustworthy there).
 *
 * A sparse + steep variant exercises graceful behaviour (recall is
 * REPORTED, not gated to a hard bar) so a regression that silently
 * collapses recall on hard terrain is still visible.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyGroundSmrf,
  type GroundFilterParams,
} from '../src/terrain/ground/groundFilter';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import {
  groundWithOverlay,
  uniformSlope,
  gaussianHill,
  gridFor,
  ASPRS,
  type SceneExtent,
} from './fixtures/terrainScenes';

// Pipeline-representative ground-filter params: an 8-cell window is large
// enough to open out the building footprint used below, and a 0.2 slope
// expectation matches analyseContours' defaults.
const PARAMS: GroundFilterParams = {
  cellSizeM: 1,
  maxWindowCells: 8,
  slope: 0.2,
  elevationThresholdM: 0.5,
  scalingFactorM: 0,
  floorPercentile: 0,
};

const EXTENT = { nx: 32, ny: 32, spacing: 1 } as const;

/** Indices of cells strictly inside a 1-cell border. */
function interiorIndices(cols: number, rows: number): number[] {
  const out: number[] = [];
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) out.push(r * cols + c);
  }
  return out;
}

/** Ground recall + non-ground leakage of a classification vs known truth. */
function scoreClassification(
  classification: Uint8Array,
  isGround: Uint8Array,
): { recall: number; leakage: number; groundTotal: number; nonGroundTotal: number } {
  let groundTotal = 0;
  let groundRecalled = 0;
  let nonGroundTotal = 0;
  let nonGroundLeaked = 0;
  for (let i = 0; i < classification.length; i++) {
    if (classification[i] === ASPRS.GROUND) {
      groundTotal++;
      if (isGround[i] === 1) groundRecalled++;
    } else {
      nonGroundTotal++;
      if (isGround[i] === 1) nonGroundLeaked++;
    }
  }
  return {
    recall: groundTotal > 0 ? groundRecalled / groundTotal : Number.NaN,
    leakage: nonGroundTotal > 0 ? nonGroundLeaked / nonGroundTotal : Number.NaN,
    groundTotal,
    nonGroundTotal,
  };
}

/** RMSE of the DTM against an analytic truth(col,row) over interior cells. */
function dtmRmseVsTruth(
  dtmZ: Float32Array,
  coverage: ArrayLike<number>,
  cols: number,
  rows: number,
  truth: (col: number, row: number) => number,
): { rmse: number; n: number } {
  let sumSq = 0;
  let n = 0;
  for (const idx of interiorIndices(cols, rows)) {
    const z = dtmZ[idx];
    if (coverage[idx] === 0 || !Number.isFinite(z)) continue;
    const col = idx % cols;
    const row = (idx - col) / cols;
    const d = z - truth(col, row);
    sumSq += d * d;
    n++;
  }
  return { rmse: n > 0 ? Math.sqrt(sumSq / n) : Number.NaN, n };
}

/**
 * Build a slope ground (class 2) plus a building (class 6) and canopy
 * (class 5) overlay placed at known heights above the analytic surface.
 * Mirrors groundWithOverlay's layout (all ground nodes first, overlays
 * appended) but for a tilted bare-earth plane the fixture doesn't cover.
 */
function slopeWithOverlay(
  gradient: number,
  z0: number,
  extent: SceneExtent,
): { points: TerrainPoint[]; classification: Uint8Array } {
  const ground = uniformSlope({ ...extent, gradient, axis: 'x', z0 });
  const points: TerrainPoint[] = [...ground];
  const cls: number[] = new Array(ground.length).fill(ASPRS.GROUND);
  const surf = (x: number): number => z0 + gradient * x;
  const addBlock = (
    i0: number,
    i1: number,
    j0: number,
    j1: number,
    heightM: number,
    code: number,
  ): void => {
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        points.push({ x: i, y: j, z: surf(i) + heightM });
        cls.push(code);
      }
    }
  };
  addBlock(10, 18, 10, 18, 10, ASPRS.BUILDING);
  addBlock(22, 28, 6, 12, 6, ASPRS.HIGH_VEGETATION);
  return { points, classification: Uint8Array.from(cls) };
}

describe('SMRF ground recovery — flat ground with building + canopy overlay', () => {
  const scene = groundWithOverlay({
    ...EXTENT,
    groundZ: 100,
    building: { i0: 10, i1: 18, j0: 10, j1: 18, heightM: 10 },
    canopy: { i0: 22, i1: 28, j0: 6, j1: 12, heightM: 6 },
  });

  it('recalls the large majority of true-ground returns (>= 95%)', () => {
    const res = classifyGroundSmrf(scene.points, PARAMS);
    const { recall, groundTotal } = scoreClassification(scene.classification, res.isGround);
    // Observed on this clean synthetic scene: 1.0 (1024/1024). Bar set at
    // 0.95 to leave headroom for harmless edge effects without hiding a real
    // regression. Drop below this and the filter is eating real ground.
    expect(groundTotal).toBeGreaterThan(900);
    expect(recall).toBeGreaterThanOrEqual(0.95);
  });

  it('rejects the large majority of non-ground (building + canopy) returns (leakage <= 10%)', () => {
    const res = classifyGroundSmrf(scene.points, PARAMS);
    const { leakage, nonGroundTotal } = scoreClassification(scene.classification, res.isGround);
    // Observed: 0.0 leakage. Building roofs (+10 m) and canopy (+6 m) are far
    // above the opened surface, so none should pass the ground tolerance.
    expect(nonGroundTotal).toBeGreaterThan(50);
    expect(leakage).toBeLessThanOrEqual(0.1);
  });

  it('builds a DTM whose interior cells match the known flat surface (RMSE < 0.05 m)', () => {
    const grid = gridFor(EXTENT);
    const groundZ = 100;
    const res = classifyGroundSmrf(scene.points, PARAMS);
    const raster = rasterizeDtm(scene.points, res.isGround, { grid });
    const dtm = buildDtmGrid(raster, { interpolation: 'geodesic' });
    const { rmse, n } = dtmRmseVsTruth(
      dtm.z,
      dtm.coverage,
      grid.cols,
      grid.rows,
      () => groundZ,
    );
    // Observed: 0.0 m — the recovered ground is exactly the flat plane on
    // interior cells. A few cm of slack guards against future interpolation
    // tweaks while still failing on any real bias.
    expect(n).toBeGreaterThan(800);
    expect(rmse).toBeLessThan(0.05);
  });
});

describe('SMRF ground recovery — uniform-slope ground with building + canopy overlay', () => {
  const gradient = 0.2;
  const z0 = 50;
  const { points, classification } = slopeWithOverlay(gradient, z0, EXTENT);

  it('recalls ground and rejects non-ground on a tilted surface', () => {
    const res = classifyGroundSmrf(points, PARAMS);
    const { recall, leakage } = scoreClassification(classification, res.isGround);
    // Observed: recall 1.0, leakage 0.0 on a 20% slope.
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(leakage).toBeLessThanOrEqual(0.1);
  });

  it('builds a DTM matching the analytic tilted plane (RMSE < 0.05 m, interior)', () => {
    const grid = gridFor(EXTENT);
    const res = classifyGroundSmrf(points, PARAMS);
    const raster = rasterizeDtm(points, res.isGround, { grid });
    const dtm = buildDtmGrid(raster, { interpolation: 'geodesic' });
    // A node at column `col` sits at x = col*spacing, so truth = z0 + g*col.
    const { rmse, n } = dtmRmseVsTruth(
      dtm.z,
      dtm.coverage,
      grid.cols,
      grid.rows,
      (col) => z0 + gradient * col,
    );
    // Observed: 0.0 m.
    expect(n).toBeGreaterThan(800);
    expect(rmse).toBeLessThan(0.05);
  });
});

describe('SMRF ground recovery — sparse + steep (graceful behaviour, reported not gated)', () => {
  it('classifies a decimated steep Gaussian hill without collapse', () => {
    const full = gaussianHill({ ...EXTENT, amplitude: 20, sigma: 5, base: 100 });
    // Deterministic decimation: keep every other node on each axis.
    const points = full.filter((_, k) => {
      const i = k % EXTENT.nx;
      const j = Math.floor(k / EXTENT.nx);
      return i % 2 === 0 && j % 2 === 0;
    });
    const res = classifyGroundSmrf(points, { ...PARAMS, slope: 0.5 });
    const recall = res.groundPointCount / points.length;
    // This is a HARD case (sparse + steep, all returns are true ground). We
    // do not gate recall to a tight bar — we assert it degrades gracefully
    // rather than collapsing, so a regression to near-zero is still caught.
    // Observed recall on this scene: ~0.74.
    expect(points.length).toBeGreaterThan(200);
    expect(res.warnings).toBeInstanceOf(Array);
    expect(recall).toBeGreaterThan(0.5);
    expect(recall).toBeLessThanOrEqual(1);
  });
});
