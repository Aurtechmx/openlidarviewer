/**
 * contourPipeline.integration.test.ts
 *
 * End-to-end debug/regression for Phases A→B→C composed together, on a
 * synthetic Gaussian hill + flat apron + an occluding building + sparse
 * trees. Unit tests pin each leaf; this asserts the leaves actually
 * compose without runtime errors and that the cross-module invariants
 * hold on realistic data.
 */

import { describe, it, expect } from 'vitest';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid, isHonestDtm } from '../src/terrain/ground/cellConfidence';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import { checkCalibration } from '../src/terrain/validate/calibrationCheck';
import { gateIntervals } from '../src/terrain/contour/intervalGate';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import { tallyContourSet, interpolatedCaption } from '../src/terrain/contour/evidenceGrade';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** Gaussian hill (amplitude 8, broad) — smooth bare earth. */
function hill(x: number, y: number): number {
  const dx = x - 25;
  const dy = y - 25;
  return 8 * Math.exp(-(dx * dx + dy * dy) / 400);
}

function buildScene(): { points: TerrainPoint[] } {
  const points: TerrainPoint[] = [];
  const inBuilding = (x: number, y: number) => x >= 10 && x <= 14 && y >= 36 && y <= 40;
  for (let x = 0; x <= 50; x++) {
    for (let y = 0; y <= 50; y++) {
      if (inBuilding(x, y)) {
        points.push({ x, y, z: hill(x, y) + 8 }); // roof, occludes ground
      } else {
        points.push({ x, y, z: hill(x, y) });
      }
    }
  }
  // A few trees.
  points.push({ x: 40, y: 12, z: hill(40, 12) + 12 });
  points.push({ x: 8, y: 8, z: hill(8, 8) + 10 });
  return { points };
}

describe('contour pipeline A→B→C (integration)', () => {
  const { points } = buildScene();
  const CELL = 2;

  const gf = classifyGroundSmrf(points, {
    cellSizeM: CELL,
    maxWindowCells: 8,
    slope: 0.3,
    elevationThresholdM: 0.5,
  });

  it('A: classifies a non-trivial ground set', () => {
    expect(gf.groundPointCount).toBeGreaterThan(0);
    expect(gf.sourcePointCount).toBe(points.length);
    expect(gf.analyzedPointCount).toBe(points.length);
  });

  const raster = rasterizeDtm(points, gf.isGround, {
    grid: {
      originH1: gf.originH1,
      originH2: gf.originH2,
      cols: gf.cols,
      rows: gf.rows,
      cellSizeM: CELL,
    },
  });
  const dtm = buildDtmGrid(raster, { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' });

  it('A: produces an honest, georeferenced DTM aligned to the filter grid', () => {
    expect(dtm.cols).toBe(gf.cols);
    expect(dtm.rows).toBe(gf.rows);
    expect(isHonestDtm(dtm)).toBe(true);
    expect(dtm.crs).toBe('EPSG:32610');
    expect(Number.isFinite(dtm.meanConfidence)).toBe(true);
  });

  const report = holdoutValidateDtm(points, gf.isGround, { cellSizeM: CELL, seed: 3 });

  it('B: cross-validates the surface with a finite, reasonable RMSE', () => {
    expect(report.sampleSize).toBeGreaterThan(0);
    expect(Number.isFinite(report.rmse)).toBe(true);
    expect(report.rmse).toBeLessThan(5); // smooth hill predicts well
    // calibration is allowed to be assessable or not depending on band
    // population, but must not throw and must return a boolean.
    const cal = checkCalibration(report);
    expect(typeof cal.calibrated).toBe('boolean');
  });

  const range = dtm && Number.isFinite(dtm.meanConfidence) ? 8 : 8; // hill amplitude
  const gate = gateIntervals({ cellSizeM: CELL, elevationRangeM: range, rmseM: report.rmse });

  it('C: gates intervals against the measured RMSE and recommends one', () => {
    expect(gate.recommendedM).not.toBeNull();
    // Any interval finer than 2*rmse must be disabled.
    for (const o of gate.options) {
      if (o.intervalM < 2 * report.rmse) expect(o.supported).toBe(false);
    }
  });

  it('C: produces graded contours with in-range confidence and an honest caption', () => {
    const set = contoursAt(dtm, { intervalM: gate.recommendedM ?? 1 });
    expect(set.levels.length).toBeGreaterThan(0);
    let segs = 0;
    for (const lvl of set.levels) {
      for (const s of lvl.segments) {
        segs++;
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(100);
        expect(['solid', 'dashed', 'gap']).toContain(s.grade);
        expect(Number.isFinite(s.x1 + s.y1 + s.x2 + s.y2)).toBe(true);
      }
    }
    expect(segs).toBeGreaterThan(0);
    const tally = tallyContourSet(set);
    expect(tally.interpolatedFraction).toBeGreaterThanOrEqual(0);
    expect(tally.interpolatedFraction).toBeLessThanOrEqual(1);
    expect(typeof interpolatedCaption(tally)).toBe('string');
  });
});
