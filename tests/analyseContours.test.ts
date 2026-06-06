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

  // The live DTM uses MEDIAN cell aggregation (robustness upgrade over mean): a
  // single high ground return in a cell must NOT pull the cell elevation. This
  // proves the wiring of the LIVE pipeline, not just the rasteriser leaf — and
  // that the new `aggregation` param + provenance report the real run.
  describe('live DTM uses median cell aggregation', () => {
    // A flat field at z=10 with ONE cell carrying an extra high outlier return
    // (10.8) among four ground returns at 10.0. mean = 10.16, median = 10.0.
    function outlierScene(): TerrainPoint[] {
      const pts: TerrainPoint[] = [];
      for (let x = 0; x <= 20; x++) for (let y = 0; y <= 20; y++) pts.push({ x, y, z: 10 });
      // Extra returns inside the single cell [10,11) × [10,11): three more at
      // 10.0 and one high outlier at 10.8 (kept as ground by a wider threshold).
      pts.push({ x: 10.2, y: 10.2, z: 10 });
      pts.push({ x: 10.5, y: 10.5, z: 10 });
      pts.push({ x: 10.7, y: 10.7, z: 10 });
      pts.push({ x: 10.3, y: 10.6, z: 10.8 });
      return pts;
    }
    const GROUND = { elevationThresholdM: 1.5 } as const;
    const median = analyseContours(outlierScene(), { cellSizeM: 1, ground: GROUND });
    const mean = analyseContours(outlierScene(), {
      cellSizeM: 1,
      ground: GROUND,
      aggregation: 'mean',
    });
    const idxOf = (dtm: { originH1: number; originH2: number; cols: number; cellSizeM: number }) => {
      const col = Math.floor((10.5 - dtm.originH1) / dtm.cellSizeM);
      const row = Math.floor((10.5 - dtm.originH2) / dtm.cellSizeM);
      return row * dtm.cols + col;
    };

    it('rejects the cell outlier (cell ≈ median 10.0, not mean 10.16)', () => {
      const mi = idxOf(median.dtm);
      const ai = idxOf(mean.dtm);
      // Both runs must have measured data in the target cell.
      expect(median.dtm.coverage[mi]).toBeGreaterThan(0);
      expect(mean.dtm.coverage[ai]).toBeGreaterThan(0);
      // Median run holds the true ground level; the mean run is pulled up.
      expect(median.dtm.z[mi]).toBeCloseTo(10.0, 3);
      expect(mean.dtm.z[ai]).toBeCloseTo(10.16, 2);
      // The two surfaces genuinely differ — proof the live default is median.
      expect(mean.dtm.z[ai] - median.dtm.z[mi]).toBeGreaterThan(0.1);
    });

    it('reports the real aggregation in generation provenance', () => {
      expect(median.generationParams.aggregation).toBe('median');
      expect(mean.generationParams.aggregation).toBe('mean');
    });
  });
});
