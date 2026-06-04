/**
 * holdoutRmse.test.ts — specs. Validates the cross-validation
 * harness against analytic surfaces where the true error is known.
 */

import { describe, it, expect } from 'vitest';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/**
 * Dense sampling (0.5 m spacing over a 0..15 m square → ~4 returns per
 * 1 m cell) so a hold-out split still leaves training data in each
 * cell. `zfn` sets the analytic surface.
 */
function surface(zfn: (x: number, y: number) => number): {
  points: TerrainPoint[];
  mask: Uint8Array;
} {
  const points: TerrainPoint[] = [];
  for (let x = 0; x <= 15; x += 0.5) {
    for (let y = 0; y <= 15; y += 0.5) {
      points.push({ x, y, z: zfn(x, y) });
    }
  }
  return { points, mask: new Uint8Array(points.length).fill(1) };
}

describe('holdoutValidateDtm', () => {
  it('reports ~zero RMSE on a perfectly flat surface', () => {
    const { points, mask } = surface(() => 5);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    expect(r.sampleSize).toBeGreaterThan(0);
    expect(r.rmse).toBeLessThan(1e-6);
    expect(r.mae).toBeLessThan(1e-6);
  });

  it('reports a small RMSE on a gently tilted plane (bilinear recovery)', () => {
    const { points, mask } = surface((x) => 0.5 * x);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    expect(r.rmse).toBeGreaterThanOrEqual(0);
    // Bilinear interpolation recovers a linear surface far better than
    // nearest-cell sampling; residual is sub-cell, not ~slope*cellSize.
    expect(r.rmse).toBeLessThan(0.6);
  });

  it('reports RMSE in metres via verticalUnitToMetres (feet source data)', () => {
    // A curved surface leaves a non-zero residual; with the same seed the
    // split is identical, so the feet run must be exactly 0.3048× the metre
    // run — proving the residuals are scaled into metres at one point.
    const { points, mask } = surface((x) => 0.1 * x * x);
    const metre = holdoutValidateDtm(points, mask, { cellSizeM: 1, seed: 3 });
    const feet = holdoutValidateDtm(points, mask, {
      cellSizeM: 1,
      seed: 3,
      verticalUnitToMetres: 0.3048,
    });
    expect(metre.rmse).toBeGreaterThan(0);
    expect(feet.rmse).toBeCloseTo(metre.rmse * 0.3048, 6);
    expect(feet.mae).toBeCloseTo(metre.mae * 0.3048, 6);
    expect(feet.p95).toBeCloseTo(metre.p95 * 0.3048, 6);
  });

  it('is deterministic for a fixed seed', () => {
    const { points, mask } = surface((x, y) => 0.3 * x + 0.2 * y);
    const a = holdoutValidateDtm(points, mask, { cellSizeM: 1, seed: 7 });
    const b = holdoutValidateDtm(points, mask, { cellSizeM: 1, seed: 7 });
    expect(a.rmse).toBe(b.rmse);
    expect(a.sampleSize).toBe(b.sampleSize);
  });

  it('carries method, coverage, and per-band structure', () => {
    const { points, mask } = surface((x) => 0.5 * x);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, seed: 1 });
    expect(r.method).toBe('holdout-cross-validation');
    expect(r.coverageMode).toBe('full');
    expect(r.perBand.map((b) => b.grade)).toEqual(['solid', 'dashed', 'gap']);
    expect(r.uncoveredCount).toBeGreaterThanOrEqual(0);
  });

  it('handles too-few-points honestly (no throw)', () => {
    const points: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
    ];
    const r = holdoutValidateDtm(points, new Uint8Array([1, 1]), { cellSizeM: 1 });
    expect(r.sampleSize).toBe(0);
    expect(r.warnings.join(' ')).toMatch(/too few/i);
  });

  it('clamps an invalid hold-out fraction with a warning', () => {
    const { points, mask } = surface(() => 1);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 1.5 });
    expect(r.holdoutFraction).toBe(0.2);
    expect(r.warnings.join(' ')).toMatch(/holdoutFraction/i);
  });
});
