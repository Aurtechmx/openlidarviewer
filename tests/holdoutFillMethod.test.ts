/**
 * holdoutFillMethod.test.ts: the hold-out validations rebuild the surface
 * with the void-fill method the delivered surface used, and the confidence
 * calibration applied to measured cells is fitted on measured-cell samples.
 */
import { describe, it, expect } from 'vitest';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import { blockedHoldoutModelOptions } from '../src/terrain/contour/analyseContours';
import { fitConfidenceCalibration } from '../src/terrain/validate/calibrateConfidence';
import type { ConfidenceSample } from '../src/terrain/validate/ValidationReport';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** A curved surface with a 12 m square gap, so void fill decides a share of the rebuilt cells. */
function gappedSurface(): { points: TerrainPoint[]; mask: Uint8Array } {
  const points: TerrainPoint[] = [];
  for (let iy = 0; iy < 40; iy++) {
    for (let ix = 0; ix < 40; ix++) {
      if (ix >= 14 && ix < 26 && iy >= 14 && iy < 26) continue;
      const x = ix + ((ix * 7 + iy * 3) % 5) * 0.11;
      const y = iy + ((ix * 5 + iy * 11) % 5) * 0.13;
      points.push({ x, y, z: 50 + 0.02 * (x - 20) ** 2 - 0.015 * (y - 20) ** 2 + 0.5 * Math.sin(x / 3) });
    }
  }
  return { points, mask: new Uint8Array(points.length).fill(1) };
}

describe('hold-out validation uses the delivered void-fill method', () => {
  it('the random hold-out scores a different surface for IDW and geodesic fill', () => {
    const { points, mask } = gappedSurface();
    const base = { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 };
    const idw = holdoutValidateDtm(points, mask, { ...base, interpolation: 'idw' });
    const geo = holdoutValidateDtm(points, mask, { ...base, interpolation: 'geodesic' });
    expect(Number.isFinite(idw.rmse) && Number.isFinite(geo.rmse)).toBe(true);
    expect(idw.rmse).not.toBe(geo.rmse);
  });

  it('the blocked hold-out options carry the fill method', () => {
    const grid = { originH1: 0, originH2: 0, cols: 10, rows: 10, cellSizeM: 1 };
    expect(blockedHoldoutModelOptions(grid, 'median', true, { interpolation: 'idw' }).interpolation).toBe('idw');
    expect(blockedHoldoutModelOptions(grid, 'median', true, {}).interpolation).toBeUndefined();
  });
});

describe('measured-cell confidence calibration', () => {
  it('the terrain core tags held-out samples by the delivered grid, so a dense scan keeps its fit', async () => {
    const { analyseContours } = await import('../src/terrain/contour/analyseContours');
    const { uniformSlope } = await import('./fixtures/terrainScenes');
    const r = analyseContours(uniformSlope({ nx: 32, ny: 32, spacing: 1, gradient: 0.1, z0: 50 }), {
      cellSizeM: 1, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703',
    });
    expect(r.quality.readiness).toBe('ready');
  });

  it('is fitted on measured-cell samples only', () => {
    const samples: ConfidenceSample[] = [];
    // Measured cells near raw 85: 83 of every 100 within tolerance.
    for (let i = 0; i < 300; i++) samples.push({ confidence: 85, absError: i % 100 < 83 ? 0.05 : 0.5, deliveredMeasured: true });
    // Measured cells near raw 35: 40 of every 100 within tolerance.
    for (let i = 0; i < 300; i++) samples.push({ confidence: 35, absError: i % 100 < 40 ? 0.05 : 0.5, deliveredMeasured: true });
    // Samples on delivered interpolated cells near raw 85, all within tolerance: pooling them lifts the curve.
    for (let i = 0; i < 900; i++) samples.push({ confidence: 85, absError: 0.01, deliveredMeasured: false });
    const fit = fitConfidenceCalibration(samples, { toleranceM: 0.1 });
    expect(fit.assessable).toBe(true);
    expect(fit.sampleSize).toBe(600);
    expect(fit.remap(85)).toBeCloseTo(83, 0);
    expect(fit.remap(35)).toBeCloseTo(40, 0);
  });

  it('keeps samples that were not mapped onto the delivered grid', () => {
    const samples: ConfidenceSample[] = [];
    for (let i = 0; i < 100; i++) samples.push({ confidence: 20 + (i % 2) * 60, absError: 0.05 });
    expect(fitConfidenceCalibration(samples, { toleranceM: 0.1 }).sampleSize).toBe(100);
  });
});
