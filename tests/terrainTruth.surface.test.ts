/**
 * terrainTruth.surface.test.ts — known-truth slope, aspect, DSM and CHM.
 *
 * Slope/aspect assert analytic Horn values; DSM/CHM assert the top-surface
 * and above-ground heights produced by classified overlay fixtures.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { computeSlopeDegrees } from '../src/terrain/surface/hillshade';
import { buildDsm, heightAboveGround } from '../src/terrain/surface/buildDsm';
import { excludeNonGroundClasses } from '../src/terrain/ground/classificationFilter';
import {
  flatPlane,
  uniformSlope,
  ridge,
  valley,
  groundWithOverlay,
  allGround,
  gridFor,
  ASPRS,
} from './fixtures/terrainScenes';

const EXTENT = { nx: 24, ny: 24, spacing: 1 } as const;
const grid = gridFor(EXTENT);
const RAD = 180 / Math.PI;

function rasterZ(pts: ReadonlyArray<{ x: number; y: number; z: number }>): Float32Array {
  const r = rasterizeDtm(pts, allGround(pts), { grid });
  return r.z;
}

/** Wrap an angle (deg) to [0, 360). */
function wrap360(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  return d;
}

describe('Slope truth (Horn)', () => {
  it('flat plane -> slope ~ 0 deg everywhere', () => {
    const z = rasterZ(flatPlane(50, EXTENT));
    const slopeDeg = computeSlopeDegrees(z, grid.cols, grid.rows, grid.cellSizeM);
    for (let r = 1; r < grid.rows - 1; r++) {
      for (let c = 1; c < grid.cols - 1; c++) {
        expect(slopeDeg[r * grid.cols + c]).toBeCloseTo(0, 4);
      }
    }
  });

  it('uniform slope -> slope angle = atan(gradient) (interior, tol 0.5 deg)', () => {
    for (const gradient of [0.1, 0.5, 1.0]) {
      const z = rasterZ(uniformSlope({ ...EXTENT, gradient, axis: 'x' }));
      const slopeDeg = computeSlopeDegrees(z, grid.cols, grid.rows, grid.cellSizeM);
      const expected = Math.atan(gradient) * RAD;
      // interior cell, away from clamped borders
      const i = 12 * grid.cols + 12;
      expect(Math.abs(slopeDeg[i] - expected)).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('Aspect truth (Horn) — downhill direction in the math frame', () => {
  it('slope rising east (axis x) -> aspect ~ 180 deg (downhill west)', () => {
    const z = rasterZ(uniformSlope({ ...EXTENT, gradient: 0.5, axis: 'x' }));
    const { aspect } = hornSlopeAspect(z, grid.cols, grid.rows, grid.cellSizeM);
    const deg = wrap360(aspect[12 * grid.cols + 12] * RAD);
    expect(Math.abs(deg - 180)).toBeLessThanOrEqual(1);
  });

  it('slope rising north (axis y, +y = northing) -> aspect ~ 270 deg (downhill south)', () => {
    // Grids are NORTHING-UP (row+1 = north), so a surface rising with y
    // rises toward the NORTH and drains south. South in the math frame
    // (CCW from east) is 270 deg. The pre-v0.4.4 expectation of 90 deg
    // encoded the mirrored (+y = south) convention.
    const z = rasterZ(uniformSlope({ ...EXTENT, gradient: 0.5, axis: 'y' }));
    const { aspect } = hornSlopeAspect(z, grid.cols, grid.rows, grid.cellSizeM);
    const deg = wrap360(aspect[12 * grid.cols + 12] * RAD);
    expect(Math.abs(deg - 270)).toBeLessThanOrEqual(1);
  });

  it('plane descending to the north (z = -y) faces north -> aspect ~ 90 deg math (geographic 0/360)', () => {
    // Aspect is the DOWNSLOPE direction. z falls as northing grows, so the
    // slope faces north: math-frame 90 deg, which `azimuthToMathRad` maps to
    // geographic azimuth 0/360 (north). Regression for the N-S mirror bug.
    const z = rasterZ(uniformSlope({ ...EXTENT, gradient: -0.5, axis: 'y' }));
    const { aspect } = hornSlopeAspect(z, grid.cols, grid.rows, grid.cellSizeM);
    const mathDeg = wrap360(aspect[12 * grid.cols + 12] * RAD);
    expect(Math.abs(mathDeg - 90)).toBeLessThanOrEqual(1);
    // Same reading expressed as a geographic azimuth: (450 − math) mod 360.
    const geoDeg = wrap360(450 - mathDeg);
    expect(Math.min(geoDeg, 360 - geoDeg)).toBeLessThanOrEqual(1); // ~0/360 = north
  });

  it('ridge: aspect flips across the crest (west flank faces W, east flank faces E)', () => {
    const z = rasterZ(ridge({ ...EXTENT, axis: 'y', amplitude: 6, sharpness: 0.15 }));
    const { aspect } = hornSlopeAspect(z, grid.cols, grid.rows, grid.cellSizeM);
    const midCol = Math.round((grid.cols - 1) / 2);
    const row = 12;
    const westDeg = wrap360(aspect[row * grid.cols + (midCol - 4)] * RAD);
    const eastDeg = wrap360(aspect[row * grid.cols + (midCol + 4)] * RAD);
    // West flank drains downhill toward west (aspect ~180), east flank toward
    // east (aspect ~0/360) — the aspect FLIP across the crest.
    expect(Math.abs(westDeg - 180)).toBeLessThanOrEqual(20);
    expect(Math.min(eastDeg, 360 - eastDeg)).toBeLessThanOrEqual(20);
  });

  it('valley: aspect flips across the trough (drains inward from both flanks)', () => {
    const z = rasterZ(valley({ ...EXTENT, axis: 'y', amplitude: 6, sharpness: 0.15 }));
    const { aspect } = hornSlopeAspect(z, grid.cols, grid.rows, grid.cellSizeM);
    const midCol = Math.round((grid.cols - 1) / 2);
    const row = 12;
    // West flank of a valley drains EAST (toward the trough, aspect ~0/360);
    // east flank drains WEST (aspect ~180). Opposite of the ridge case.
    const westDeg = wrap360(aspect[row * grid.cols + (midCol - 4)] * RAD);
    const eastDeg = wrap360(aspect[row * grid.cols + (midCol + 4)] * RAD);
    expect(Math.min(westDeg, 360 - westDeg)).toBeLessThanOrEqual(20); // ~0/360
    expect(Math.abs(eastDeg - 180)).toBeLessThanOrEqual(20); // ~180
  });
});

describe('DSM / CHM truth — building + canopy on a ground plane', () => {
  // 24x24 ground plane at z=100. Building (class 6, +10 m) over a 6x6 block,
  // canopy (class 5, +6 m) over a separate 5x5 block. Bare ground elsewhere.
  const scene = groundWithOverlay({
    ...EXTENT,
    groundZ: 100,
    building: { i0: 4, i1: 10, j0: 4, j1: 10, heightM: 10 },
    canopy: { i0: 14, i1: 19, j0: 14, j1: 19, heightM: 6 },
  });

  // DTM: ground returns only (classification excludes 5 & 6). The filter
  // returns the KEPT points; rasterise those with an all-ground mask.
  const classFilter = excludeNonGroundClasses(scene.points, scene.classification);
  const dtmRaster = rasterizeDtm(classFilter.points, allGround(classFilter.points), { grid });

  // DSM: top surface from ALL points on the same grid.
  const dsm = buildDsm(scene.points, { grid });

  const dtmCoverage = new Uint8Array(dtmRaster.counts.length);
  for (let i = 0; i < dtmCoverage.length; i++) dtmCoverage[i] = dtmRaster.counts[i] > 0 ? 2 : 0;
  const chm = heightAboveGround(dsm, dtmRaster.z, dtmCoverage);

  const idx = (c: number, r: number) => r * grid.cols + c;

  it('DTM equals bare ground (100) under the building and canopy footprints', () => {
    expect(dtmRaster.z[idx(6, 6)]).toBeCloseTo(100, 6); // under building
    expect(dtmRaster.z[idx(16, 16)]).toBeCloseTo(100, 6); // under canopy
    expect(dtmRaster.z[idx(0, 0)]).toBeCloseTo(100, 6); // bare ground
  });

  it('DSM is the top surface: roof (110) over the building, canopy top (106) over trees', () => {
    expect(dsm.z[idx(6, 6)]).toBeCloseTo(110, 6); // 100 + 10
    expect(dsm.z[idx(16, 16)]).toBeCloseTo(106, 6); // 100 + 6
    expect(dsm.z[idx(0, 0)]).toBeCloseTo(100, 6); // bare ground = ground level
  });

  it('CHM equals the structure height over footprints, ~0 on bare ground', () => {
    expect(chm.heightM[idx(6, 6)]).toBeCloseTo(10, 6); // building height
    expect(chm.heightM[idx(16, 16)]).toBeCloseTo(6, 6); // canopy height
    expect(chm.heightM[idx(0, 0)]).toBeCloseTo(0, 6); // bare ground
    expect(chm.maxHeightM).toBeCloseTo(10, 6);
  });

  it('classification excludes the right number of non-ground returns', () => {
    const building = 6 * 6;
    const canopy = 5 * 5;
    expect(classFilter.excludedCount).toBe(building + canopy);
    // Excluded returns are class 5 and 6 only.
    expect(scene.classification.filter((c) => c === ASPRS.BUILDING).length).toBe(building);
    expect(scene.classification.filter((c) => c === ASPRS.HIGH_VEGETATION).length).toBe(canopy);
  });

  it('nodata is preserved where the DSM grid has no points (none here: full coverage)', () => {
    // This scene is fully covered by ground, so DSM coverage is complete; the
    // honest contract is that an uncovered cell would be NaN. Verify the
    // builder marks all cells covered here.
    let covered = 0;
    for (let i = 0; i < dsm.coverage.length; i++) covered += dsm.coverage[i];
    expect(covered).toBe(grid.cols * grid.rows);
  });
});
