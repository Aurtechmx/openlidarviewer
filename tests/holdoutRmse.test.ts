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

  it('discloses the classify-before-split limitation in its warnings', () => {
    const { points, mask } = surface((x) => 0.3 * x);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    expect(r.warnings.some((w) => /classification used the full cloud/i.test(w))).toBe(true);
  });

  it('tags collected samples with their surface zone (for the reliability split)', () => {
    const { points, mask } = surface((x) => 0.5 * x);
    const r = holdoutValidateDtm(points, mask, {
      cellSizeM: 1, holdoutFraction: 0.3, seed: 1, collectSamples: true,
    });
    expect(r.samples && r.samples.length).toBeGreaterThan(0);
    // Every collected sample now carries a measured/interpolated zone so the
    // measured-vs-model reliability split can separate the two.
    for (const s of r.samples ?? []) {
      expect(s.zone === 'measured' || s.zone === 'interpolated').toBe(true);
    }
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

/**
 * DEFECT 1 — classify-before-split. The default path keeps the full-cloud
 * classification and discloses it. The `reclassifyGround` hook actually removes
 * the leak: it re-runs classification on training points only (held-out points
 * excluded), so the surface fit is no longer built with the held-out points'
 * ground membership decided using themselves.
 */
describe('holdoutValidateDtm — train-only reclassification (classify-before-split fix)', () => {
  /**
   * Constructed leak fixture. True ground is a flat z=0 plane. A ridge of
   * BLUNDER returns sits at z=10 (non-ground in the full-cloud mask). The
   * injected classifier is deliberately leak-sensitive: it promotes the ridge to
   * ground ONLY when some points are held out — standing in for a real
   * classifier whose decision shifts once the held-out points leave the cloud.
   * With the full-cloud mask the surface is clean (RMSE≈0, optimistic); with
   * train-only reclassification the ridge enters the fit, lifting the surface and
   * revealing a real, larger residual — the optimism is removed.
   */
  function leakScenario(): { points: TerrainPoint[]; isGround: Uint8Array } {
    const points: TerrainPoint[] = [];
    const isGround: number[] = [];
    for (let x = 0; x <= 8; x += 0.5) {
      for (let y = 0; y <= 8; y += 0.5) {
        points.push({ x, y, z: 0 });
        isGround.push(1);
      }
    }
    for (let x = 0; x <= 8; x += 0.5) {
      points.push({ x, y: 4.25, z: 10 }); // ridge blunders, initially non-ground
      isGround.push(0);
    }
    return { points, isGround: Uint8Array.from(isGround) };
  }

  // The leak-sensitive classifier: ridge (z>5) becomes ground only when the
  // held-out set is non-empty; true-ground points stay ground.
  const leakClassifier = (
    pts: ReadonlyArray<TerrainPoint>,
    heldOut: Uint8Array,
  ): Uint8Array => {
    let any = 0;
    for (const v of heldOut) if (v) { any = 1; break; }
    return Uint8Array.from(pts.map((p) => (p.z > 5 ? any : 1)));
  };

  it('default path keeps the full-cloud classification and discloses it', () => {
    const { points, isGround } = leakScenario();
    const r = holdoutValidateDtm(points, isGround, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    expect(r.warnings.some((w) => /classification used the full cloud/i.test(w))).toBe(true);
    // Full-cloud surface is clean: the optimistic ≈0 RMSE.
    expect(r.rmse).toBeLessThan(1e-6);
  });

  it('reclassifyGround removes the optimism: held-out estimate no longer biased low', () => {
    const { points, isGround } = leakScenario();
    const full = holdoutValidateDtm(points, isGround, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    const reclassed = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      holdoutFraction: 0.3,
      seed: 1,
      reclassifyGround: leakClassifier,
    });
    // The train-only fit reveals a real residual the full-cloud fit hid.
    expect(reclassed.rmse).toBeGreaterThan(full.rmse);
    expect(reclassed.rmse).toBeGreaterThan(0.5);
    // Disclosure flips: leak removed, no longer the "full cloud" caveat.
    expect(reclassed.warnings.some((w) => /re-run on training points only/i.test(w))).toBe(true);
    expect(reclassed.warnings.some((w) => /classification used the full cloud/i.test(w))).toBe(false);
  });

  it('never shows the classifier the held-out points (leak is structurally removed)', () => {
    const { points, isGround } = leakScenario();
    let seen: Uint8Array | null = null;
    holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      holdoutFraction: 0.3,
      seed: 1,
      reclassifyGround: (pts, heldOut) => {
        seen = heldOut;
        return leakClassifier(pts, heldOut);
      },
    });
    expect(seen).not.toBeNull();
    const flags = seen as unknown as Uint8Array;
    let held = 0;
    flags.forEach((v, i) => {
      if (v) {
        held++;
        // Only ground returns are ever withheld — every held-out flag is ground.
        expect(isGround[i]).toBe(1);
      }
    });
    expect(held).toBeGreaterThan(0);
  });

  it('is deterministic with the reclassifier for a fixed seed', () => {
    const { points, isGround } = leakScenario();
    const a = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1, holdoutFraction: 0.3, seed: 5, reclassifyGround: leakClassifier,
    });
    const b = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1, holdoutFraction: 0.3, seed: 5, reclassifyGround: leakClassifier,
    });
    expect(a.rmse).toBe(b.rmse);
    expect(a.sampleSize).toBe(b.sampleSize);
  });

  it('falls back to the full-cloud disclosure when the reclassifier returns an invalid mask', () => {
    const { points, isGround } = leakScenario();
    const r = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      holdoutFraction: 0.3,
      seed: 1,
      reclassifyGround: () => new Uint8Array(3), // wrong length
    });
    expect(r.warnings.some((w) => /invalid mask/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /classification used the full cloud/i.test(w))).toBe(true);
  });
});
