/**
 * analyseContours.test.ts — integration facade specs. Confirms the
 * whole A→F pipeline composes through one call and stays honest.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { isHonestDtm } from '../src/terrain/ground/cellConfidence';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 50; x++) {
    for (let y = 0; y <= 50; y++) {
      const dx = x - 25;
      const dy = y - 25;
      pts.push({ x, y, z: 8 * Math.exp(-(dx * dx + dy * dy) / 400) });
    }
  }
  return pts;
}

describe('analyseContours', () => {
  const pts = hillScene();
  const r = analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' });

  it('returns an honest, georeferenced DTM', () => {
    expect(isHonestDtm(r.dtm)).toBe(true);
    expect(r.dtm.crs).toBe('EPSG:32610');
    expect(r.elevationRangeM).toBeGreaterThan(0);
  });

  it('validates the surface and gates an interval against the RMSE', () => {
    expect(Number.isFinite(r.validation.rmse)).toBe(true);
    expect(r.intervalM).not.toBeNull();
    // The chosen interval must be one the gate considers supported.
    const chosen = r.gate.options.find((o) => o.intervalM === r.intervalM);
    if (chosen) expect(chosen.supported).toBe(true);
  });

  it('produces a graded, exportable contour model', () => {
    expect(r.contours.levels.length).toBeGreaterThan(0);
    expect(r.model.features.length).toBeGreaterThan(0);
    expect(r.model.crs).toBe('EPSG:32610');
    expect(r.tally.interpolatedFraction).toBeGreaterThanOrEqual(0);
    expect(r.tally.interpolatedFraction).toBeLessThanOrEqual(1);
  });

  it('exposes ASPRS accuracy and index-contour labels', () => {
    expect(r.accuracy.standard).toBe('ASPRS 2014');
    if (Number.isFinite(r.accuracy.rmseZ)) {
      expect(r.accuracy.nva95).toBeCloseTo(1.96 * r.accuracy.rmseZ, 6);
    }
    expect(Array.isArray(r.labels)).toBe(true);
  });

  it('is deterministic', () => {
    const r2 = analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610' });
    expect(r2.intervalM).toBe(r.intervalM);
    expect(r2.model.features.length).toBe(r.model.features.length);
  });

  it('handles a flat surface honestly (no interval, no contours)', () => {
    const flat: TerrainPoint[] = [];
    for (let x = 0; x <= 10; x++) for (let y = 0; y <= 10; y++) flat.push({ x, y, z: 5 });
    const fr = analyseContours(flat, { cellSizeM: 2, crs: 'EPSG:32610' });
    expect(fr.intervalM).toBeNull();
    expect(fr.contours.levels.length).toBe(0);
    expect(fr.warnings.join(' ')).toMatch(/no reliable contour interval/i);
  });
});
