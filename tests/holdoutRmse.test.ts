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

  it('types the report as point-reconstruction, never external-checkpoint accuracy', () => {
    const { points, mask } = surface(() => 5);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 0.3, seed: 1 });
    // A random-point hold-out estimates local reconstruction under dense
    // sampling; the typed estimand stops any consumer relabelling it as an
    // independent-checkpoint accuracy (which alone could back an ASPRS claim).
    expect(r.estimand).toBe('point-reconstruction');
    expect(r.estimand).not.toBe('external-checkpoint');
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
    // PHYSICAL INVARIANCE, not a scaling identity. Describe ONE terrain twice —
    // once with heights in metres, once with the same heights in feet plus
    // `verticalUnitToMetres` — and the metric RMSE must come out the same. The
    // whole chain (despike floor, geodesic path cost, slope bands, residual
    // conversion) has to be unit-aware for that to hold; a unit bug anywhere in
    // it moves the ratio off 1.
    //
    // The earlier form fed the SAME NUMBERS to both runs and expected exactly
    // 0.3048x. That is two different terrains, one 3.28x flatter, so the
    // now-unit-aware void fill legitimately parts them by ~1e-3 and the
    // assertion had to be a tolerance band fitted to the fixture.
    const zfn = (x: number): number => 0.1 * x * x;
    const metric = surface(zfn);
    const imperial = surface((x) => zfn(x) / 0.3048);

    const metre = holdoutValidateDtm(metric.points, metric.mask, { cellSizeM: 1, seed: 3 });
    const feet = holdoutValidateDtm(imperial.points, imperial.mask, {
      cellSizeM: 1,
      seed: 3,
      verticalUnitToMetres: 0.3048,
    });
    expect(metre.rmse).toBeGreaterThan(0);
    // Both are already in metres, so they are equal up to f32 grid storage.
    expect(feet.rmse / metre.rmse).toBeCloseTo(1, 6);
    expect(feet.mae / metre.mae).toBeCloseTo(1, 6);
    expect(feet.p95 / metre.p95).toBeCloseTo(1, 6);
    // Drop the conversion entirely and the feet run reports ~3.28x — this is
    // still a hard gate on the residuals reaching metres.
    const unconverted = holdoutValidateDtm(imperial.points, imperial.mask, {
      cellSizeM: 1,
      seed: 3,
    });
    expect(unconverted.rmse / metre.rmse).toBeGreaterThan(3);
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

  it('refuses an invalid hold-out fraction instead of substituting 0.2', () => {
    // Repairing it produced a real RMSE for a split design the caller never
    // chose, under a `holdoutFraction` field that then read 0.2 as though that
    // had been asked for. The only trace was a warning line, which no panel
    // renders. A statistical parameter is refused, not corrected.
    const { points, mask } = surface(() => 1);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, holdoutFraction: 1.5 });
    expect(r.sampleSize, 'a figure was produced for a design nobody chose').toBe(0);
    expect(r.unavailableReason).toMatch(/holdoutFraction/i);
  });

  it('refuses a non-positive cell size instead of substituting 1', () => {
    const { points, mask } = surface(() => 1);
    const r = holdoutValidateDtm(points, mask, { cellSizeM: 0 });
    expect(r.sampleSize).toBe(0);
    expect(r.unavailableReason).toMatch(/cellSizeM/i);
  });

  it('refuses a seed mulberry32 would silently rewrite', () => {
    // `seed >>> 0` maps -1 to 4294967295 and 2.5 to 2, so a recorded seed would
    // not reproduce its own split and two "different" seeds could be one split.
    const { points, mask } = surface(() => 1);
    for (const seed of [-1, 2.5, Number.NaN]) {
      const r = holdoutValidateDtm(points, mask, { cellSizeM: 1, seed });
      expect(r.sampleSize, `seed ${seed} was accepted`).toBe(0);
      expect(r.unavailableReason).toMatch(/seed/i);
    }
  });

  it('states the refusal it actually made, not the nearest one', () => {
    // Four ground points and a split fraction of 0.999 send every point to the
    // test set, so the train set is empty. That refusal pushed its own warning
    // but returned the report with the DEFAULT reason, and the panel printed
    // "too few ground returns to cross-validate" for a run that had enough
    // returns and an empty split. The reason must be the warning.
    const points = [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 },
    ];
    const r = holdoutValidateDtm(points, new Uint8Array([1, 1, 1, 1]), {
      cellSizeM: 1, holdoutFraction: 0.999, seed: 1,
    });
    expect(r.sampleSize).toBe(0);
    expect(r.warnings.join(' '), 'the fixture did not produce an empty split')
      .toMatch(/empty train or test set/);
    expect(r.unavailableReason).toMatch(/empty train or test set/);
    expect(r.unavailableReason).not.toMatch(/too few ground returns/);
  });

  it('refuses a ground mask that does not cover the cloud', () => {
    // A short mask reads `undefined` past its end, which is `!== 1`, so every
    // point beyond it silently becomes non-ground: the validated sample turns
    // into a prefix of the intended one with no field saying so.
    const { points, mask } = surface(() => 1);
    const half = mask.slice(0, Math.floor(mask.length / 2));
    const r = holdoutValidateDtm(points, half, { cellSizeM: 1 });
    expect(r.sampleSize, 'half a mask silently validated half a cloud').toBe(0);
    expect(r.unavailableReason).toMatch(/mask length/i);
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

  it('refuses rather than answering with the whole-cloud estimand when the mask is invalid', () => {
    // Supplying `reclassifyGround` SELECTS split -> classify -> fit. If that
    // cannot be produced, the whole-cloud figure is an answer to a different
    // question, and it used to arrive in the same `rmse` field with a warning
    // appended. Labelling it `classificationScope: 'whole-cloud'` disclosed the
    // substitution but did not stop a panel or a paper quoting the number.
    const { points, isGround } = leakScenario();
    const r = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      holdoutFraction: 0.3,
      seed: 1,
      reclassifyGround: () => new Uint8Array(3), // wrong length
    });
    expect(r.sampleSize, 'a whole-cloud figure was returned for a train-only request').toBe(0);
    expect(Number.isNaN(r.rmse)).toBe(true);
    expect(r.unavailableReason).toMatch(/train-only/i);
    expect(r.warnings.some((w) => /invalid mask/i.test(w))).toBe(true);
  });

  it('refuses when the train-only classifier finds no ground', () => {
    const { points, isGround } = leakScenario();
    const succeeded = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1, holdoutFraction: 0.3, seed: 5, reclassifyGround: leakClassifier,
    });
    // The refusals below prove nothing if the success path stopped working.
    expect(succeeded.classificationScope).toBe('train-only');
    expect(succeeded.sampleSize).toBeGreaterThan(0);
    expect(succeeded.unavailableReason).toBeNull();

    const empty = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      holdoutFraction: 0.3,
      seed: 5,
      reclassifyGround: (p) => new Uint8Array(p.length),
    });
    expect(empty.sampleSize).toBe(0);
    expect(empty.unavailableReason).toMatch(/train-only/i);
    expect(empty.warnings.some((w) => /no ground points/i.test(w))).toBe(true);
  });
});
