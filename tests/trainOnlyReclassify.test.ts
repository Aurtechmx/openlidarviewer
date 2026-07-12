/**
 * trainOnlyReclassify.test.ts — the shipped analysis path closes the
 * classify-before-split leak.
 *
 * v0.5.9 added the `reclassifyGround` hook to `holdoutValidateDtm` but did not
 * wire it: shipped terrain products still validated against a ground mask the
 * classifier decided with the held-out points in view (disclosed optimism).
 * These tests pin the fix:
 *
 *   (a) the shipped path (`computeTerrainCore`) actually PASSES the hook —
 *       not merely supports it;
 *   (b) the per-split classification sees ONLY training points, and the
 *       returned mask can never call a held-out point ground;
 *   (c) the disclosure flips: the hooked path drops the full-cloud caveat the
 *       unhooked path states;
 *   (d) determinism — two identical runs produce identical reports;
 *   (e) no parameter drift — with nothing held out, the reclassifier
 *       reproduces the main-pass mask bit-for-bit (same algorithm, same
 *       resolved parameters).
 *
 * Pure data: no DOM, no I/O. Deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  makeTrainOnlyReclassifier,
  type GroundClassifierFn,
} from '../src/terrain/validate/trainOnlyReclassify';
import {
  computeTerrainCore,
  resolveGroundFilterParams,
  type TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import { gaussianHill } from './fixtures/terrainScenes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const SMRF_PARAMS = {
  cellSizeM: 2,
  maxWindowCells: 8,
  slope: 0.2,
  elevationThresholdM: 0.5,
  floorPercentile: 5,
  verticalAxis: 'z',
} as const;

/** Mark every 4th point held out (deterministic, non-empty both ways). */
function everyFourthHeldOut(n: number): Uint8Array {
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i += 4) flags[i] = 1;
  return flags;
}

describe('makeTrainOnlyReclassifier — train-only ground classification', () => {
  it('the classifier never sees a held-out point', () => {
    const pts = gaussianHill({ amplitude: 12 });
    const heldOut = everyFourthHeldOut(pts.length);
    let seen: ReadonlyArray<TerrainPoint> | null = null;
    const spy: GroundClassifierFn = (trainPts) => {
      seen = trainPts;
      return { isGround: new Uint8Array(trainPts.length).fill(1) };
    };
    makeTrainOnlyReclassifier(SMRF_PARAMS, spy)(pts, heldOut);
    expect(seen).not.toBeNull();
    const got = seen as unknown as ReadonlyArray<TerrainPoint>;
    // Exactly the training points, in source order — no held-out point leaks in.
    const expectedTrain = pts.filter((_, i) => heldOut[i] !== 1);
    expect(got.length).toBe(expectedTrain.length);
    for (let j = 0; j < got.length; j++) expect(got[j]).toBe(expectedTrain[j]);
  });

  it('maps verdicts back to source indices; held-out indices are always 0', () => {
    const pts = gaussianHill({ amplitude: 12 });
    const heldOut = everyFourthHeldOut(pts.length);
    // Alternating verdicts so the scatter-back is actually exercised.
    const spy: GroundClassifierFn = (trainPts) => ({
      isGround: Uint8Array.from(trainPts.map((_, j) => (j % 2) as 0 | 1)),
    });
    const mask = makeTrainOnlyReclassifier(SMRF_PARAMS, spy)(pts, heldOut);
    expect(mask.length).toBe(pts.length);
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      if (heldOut[i] === 1) {
        expect(mask[i]).toBe(0); // a held-out point can never be called ground
      } else {
        expect(mask[i]).toBe(j % 2);
        j++;
      }
    }
  });

  it('returns an all-zero mask without classifying when everything is held out', () => {
    const pts = gaussianHill({ amplitude: 12 });
    let called = 0;
    const spy: GroundClassifierFn = (trainPts) => {
      called++;
      return { isGround: new Uint8Array(trainPts.length) };
    };
    const mask = makeTrainOnlyReclassifier(SMRF_PARAMS, spy)(
      pts,
      new Uint8Array(pts.length).fill(1),
    );
    expect(called).toBe(0);
    expect(mask.every((v) => v === 0)).toBe(true);
  });

  it('is deterministic with the real SMRF classifier', () => {
    const pts = gaussianHill({ amplitude: 12 });
    const heldOut = everyFourthHeldOut(pts.length);
    const a = makeTrainOnlyReclassifier(SMRF_PARAMS)(pts, heldOut);
    const b = makeTrainOnlyReclassifier(SMRF_PARAMS)(pts, heldOut);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('with nothing held out, reproduces the main-pass mask bit-for-bit (no parameter drift)', () => {
    const pts = gaussianHill({ amplitude: 12 });
    const coreParams: TerrainCoreParams = { cellSizeM: 2, crs: 'EPSG:32610' };
    const resolved = resolveGroundFilterParams(coreParams, 'z');
    const main = classifyGroundSmrf(pts, resolved);
    const mask = makeTrainOnlyReclassifier(resolved)(pts, new Uint8Array(pts.length));
    expect(Array.from(mask)).toEqual(Array.from(main.isGround));
  });
});

describe('computeTerrainCore — the shipped path passes the hook', () => {
  const pts = gaussianHill({ amplitude: 12 });
  const params: TerrainCoreParams = { cellSizeM: 2, crs: 'EPSG:32610' };

  it('(a)+(c) the hook is invoked and the disclosure flips vs the unhooked path', () => {
    const core = computeTerrainCore(pts, params);
    const joined = core.validation.warnings.join(' ');
    // Leak removed — the hooked path says so and drops the full-cloud caveat.
    expect(joined).toMatch(/re-run on training points only/i);
    expect(joined).not.toMatch(/classification used the full cloud/i);
    // And it really validated (the flip is not a degenerate empty report).
    expect(core.validation.sampleSize).toBeGreaterThan(0);
    expect(Number.isFinite(core.validation.rmse)).toBe(true);

    // The SAME inputs through the pre-fix wiring (no hook) keep the caveat.
    const gf = classifyGroundSmrf(pts, resolveGroundFilterParams(params, 'z'));
    const unhooked = holdoutValidateDtm(pts, gf.isGround, {
      cellSizeM: params.cellSizeM,
      seed: 1,
      aggregation: 'median',
    });
    expect(unhooked.warnings.join(' ')).toMatch(/classification used the full cloud/i);
    expect(unhooked.warnings.join(' ')).not.toMatch(/re-run on training points only/i);
  });

  it('(d) two identical runs produce identical validation reports', () => {
    const a = computeTerrainCore(pts, params);
    const b = computeTerrainCore(pts, params);
    expect(a.validation.rmse).toBe(b.validation.rmse);
    expect(a.validation.mae).toBe(b.validation.mae);
    expect(a.validation.sampleSize).toBe(b.validation.sampleSize);
    expect(a.validation.warnings).toEqual(b.validation.warnings);
    expect(Array.from(a.dtm.z)).toEqual(Array.from(b.dtm.z));
  });
});
