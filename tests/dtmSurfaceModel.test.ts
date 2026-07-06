/**
 * dtmSurfaceModel.test.ts
 *
 * The DTM-backed surface adapter lets the spatial-block estimator score the
 * real production surface. This confirms the adapter fits + predicts on a fixed
 * grid and drives blocked cross-validation end to end on a curved surface where
 * predicting across a held-out block has genuine error.
 */

import { describe, it, expect } from 'vitest';
import { DtmSurfaceModel } from '../src/terrain/validate/dtmSurfaceModel';
import { spatialBlockHoldout, type XYZ } from '../src/terrain/validate/spatialBlockHoldout';

/** A curved surface (z bends in x) so a gap can't be recovered exactly. */
function curved(n = 30, step = 0.5): XYZ[] {
  const pts: XYZ[] = [];
  for (let x = 0; x <= n; x += step) {
    for (let y = 0; y <= n; y += step) {
      pts.push({ x, y, z: 0.02 * x * x + 0.5 * y });
    }
  }
  return pts;
}

describe('DtmSurfaceModel + spatial-block CV', () => {
  it('fits and predicts the production surface across held-out blocks', () => {
    const pts = curved();
    const model = new DtmSurfaceModel({
      grid: { originH1: 0, originH2: 0, cols: 31, rows: 31, cellSizeM: 1 },
      aggregation: 'median',
    });
    const r = spatialBlockHoldout(pts, model, { blockSize: 4, seed: 5, folds: 4, bootstrapN: 300 });
    expect(r.method).toBe('spatial-block-cv');
    expect(r.blocks).toBeGreaterThan(1);
    expect(r.n).toBeGreaterThan(0);
    expect(Number.isFinite(r.rmse)).toBe(true);
    expect(r.rmse).toBeGreaterThan(0); // curved surface → non-zero gap error
    expect(r.ciLow).toBeLessThanOrEqual(r.rmse);
    expect(r.ciHigh).toBeGreaterThanOrEqual(r.rmse);
  });

  it('is deterministic for a fixed seed', () => {
    const pts = curved();
    const mk = () => new DtmSurfaceModel({
      grid: { originH1: 0, originH2: 0, cols: 31, rows: 31, cellSizeM: 1 },
      aggregation: 'median',
    });
    const a = spatialBlockHoldout(pts, mk(), { blockSize: 4, seed: 9 });
    const b = spatialBlockHoldout(pts, mk(), { blockSize: 4, seed: 9 });
    expect(b.rmse).toBe(a.rmse);
    expect(b.ciLow).toBe(a.ciLow);
  });

  it('predict returns null off the fitted surface', () => {
    const model = new DtmSurfaceModel({
      grid: { originH1: 0, originH2: 0, cols: 10, rows: 10, cellSizeM: 1 },
    });
    // Not fitted yet → no coverage anywhere.
    expect(model.predict(5, 5)).toBeNull();
  });

  it('refuses to extrapolate outside the grid domain (returns null, not an edge value)', () => {
    const model = new DtmSurfaceModel({
      grid: { originH1: 0, originH2: 0, cols: 10, rows: 10, cellSizeM: 1 },
    });
    model.fit([
      { x: 1, y: 1, z: 5 }, { x: 2, y: 2, z: 5 }, { x: 3, y: 3, z: 5 }, { x: 8, y: 8, z: 5 },
    ]);
    // Well outside the 10×10 grid → no prediction, rather than clamping to an edge cell.
    expect(model.predict(100, 100)).toBeNull();
    expect(model.predict(-50, 5)).toBeNull();
  });
});
