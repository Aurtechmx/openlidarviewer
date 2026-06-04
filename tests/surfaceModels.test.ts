/**
 * surfaceModels.test.ts — DSM, height-above-ground, slope (deg), hillshade.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDsm,
  emptySurfaceGrid,
  surfaceStats,
  heightAboveGround,
} from '../src/terrain/surface/buildDsm';
import {
  computeSlopeDegrees,
  computeHillshade,
  slopeStats,
} from '../src/terrain/surface/hillshade';

describe('buildDsm — top surface (max return per cell)', () => {
  const grid = { originH1: 0, originH2: 0, cols: 2, rows: 2, cellSizeM: 1 };
  const dsm = buildDsm(
    [
      { x: 0.5, y: 0.5, z: 1 }, { x: 0.5, y: 0.5, z: 5 }, { x: 0.5, y: 0.5, z: 3 }, // cell 0 → max 5
      { x: 1.5, y: 0.5, z: 2 }, // cell 1
      { x: 0.5, y: 1.5, z: 10 }, // cell 2
      // cell 3 has no points
    ],
    { grid },
  );

  it('keeps the highest return per cell and marks empty cells NaN', () => {
    expect(dsm.z[0]).toBe(5);
    expect(dsm.z[1]).toBe(2);
    expect(dsm.z[2]).toBe(10);
    expect(dsm.coverage[3]).toBe(0);
    expect(Number.isNaN(dsm.z[3])).toBe(true);
  });

  it('emptySurfaceGrid is all-NaN with zero coverage', () => {
    const g = emptySurfaceGrid({ originH1: 0, originH2: 0, cols: 2, rows: 2, cellSizeM: 1 });
    expect(g.z.length).toBe(4);
    expect(Array.from(g.coverage)).toEqual([0, 0, 0, 0]);
    expect(g.z.every((v) => Number.isNaN(v))).toBe(true);
    expect(surfaceStats(g).coveredCells).toBe(0);
  });

  it('surfaceStats over covered cells', () => {
    const s = surfaceStats(dsm);
    expect(s.coveredCells).toBe(3);
    expect(s.minZ).toBe(2);
    expect(s.maxZ).toBe(10);
    expect(s.meanZ).toBeCloseTo((5 + 2 + 10) / 3, 6);
  });

  it('height above ground = DSM − DTM (clamped ≥ 0) where both exist', () => {
    const dtmZ = Float32Array.from([0, 0, 5, 0]);
    const dtmCov = Uint8Array.from([1, 1, 1, 0]);
    const c = heightAboveGround(dsm, dtmZ, dtmCov);
    expect(c.heightM[0]).toBe(5); // 5 − 0
    expect(c.heightM[2]).toBe(5); // 10 − 5
    expect(Number.isNaN(c.heightM[3])).toBe(true); // dtm not covered
    expect(c.coveredCells).toBe(3);
    expect(c.maxHeightM).toBe(5);
    expect(c.meanHeightM).toBeCloseTo((5 + 2 + 5) / 3, 6);
  });
});

describe('slope + hillshade', () => {
  // A planar surface z = column index → constant 1:1 grade across X.
  const cols = 3, rows = 3;
  const planar = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) planar[r * cols + c] = c;
  const cov = new Uint8Array(cols * rows).fill(1);

  it('computeSlopeDegrees turns a 1:1 grade into ~45°', () => {
    const deg = computeSlopeDegrees(planar, cols, rows, 1);
    expect(deg[4]).toBeCloseTo(45, 1); // centre cell
  });

  it('hillshade of a flat surface is uniform = 255·cos(zenith)', () => {
    const flat = new Float32Array(cols * rows).fill(5);
    const hs = computeHillshade(flat, cols, rows, 1, cov, { azimuthDeg: 315, altitudeDeg: 45 });
    // zenith 45° → 255·cos45 ≈ 180, identical on every covered cell.
    expect(hs.shade[4]).toBe(180);
    expect(new Set(Array.from(hs.shade)).size).toBe(1);
  });

  it('hillshade leaves empty cells dark (0) and reports their coverage', () => {
    const z = new Float32Array(cols * rows).fill(5);
    z[4] = NaN;
    const cov2 = new Uint8Array(cols * rows).fill(1);
    cov2[4] = 0;
    const hs = computeHillshade(z, cols, rows, 1, cov2);
    expect(hs.shade[4]).toBe(0);
    // coverage lets a renderer distinguish no-data from deep shadow.
    expect(hs.coverage[4]).toBe(0);
    expect(hs.coverage[0]).toBe(1);
  });

  it('a degree-scale cell size inflates slope unless converted to metres', () => {
    // A 1-unit (metre) rise per column over a 1e-5° cell ≈ vertical wall if the
    // gradient is computed in raw degrees; converting the cell to metres
    // (×111_320 m/°) restores a physically meaningful slope. This locks the
    // orchestrator's geographic correction rationale.
    const degCell = 1e-5;
    const rawDeg = computeSlopeDegrees(planar, cols, rows, degCell);
    expect(rawDeg[4]).toBeGreaterThan(89); // absurd in raw degrees
    const metresCell = degCell * 111_320;
    const fixedDeg = computeSlopeDegrees(planar, cols, rows, metresCell);
    expect(fixedDeg[4]).toBeGreaterThan(30);
    expect(fixedDeg[4]).toBeLessThan(50); // ~42°, sane
  });

  it('slopeStats buckets a steep planar grade as steep', () => {
    const deg = computeSlopeDegrees(planar, cols, rows, 1);
    const s = slopeStats(deg, cov);
    expect(s.coveredCells).toBe(9);
    // Every cell is ≥ 20° (interior 45°, edge columns ~26.6° from clamping).
    expect(s.bands.steep).toBe(9);
    expect(s.meanDeg).toBeGreaterThan(20);
    expect(s.maxDeg).toBeCloseTo(45, 0);
  });
});
