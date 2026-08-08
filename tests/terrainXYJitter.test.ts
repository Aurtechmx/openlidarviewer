/**
 * terrainXYJitter.test.ts — quick-win 3. Seeded horizontal-jitter perturbation
 * on the real White Sands ground.
 *
 * A controlled XY positional perturbation (σ = 0.05 m, 0.15 m) moves points
 * between cells at the grid resolution, so its effect shows in the DTM through
 * re-binning and in slope/aspect through the changed surface. Each run records
 * seed, magnitude, input hash, perturbed hash and the metrics, so the exact
 * perturbed data is reproducible from the record. Validation-only.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { gridErrorStats, aspectErrorStats } from '../src/validation/terrainMetrics';
import { perturbXY, hashPoints } from '../src/validation/terrainPerturbation';
import { readWhiteSandsGround, WS_GRID, hasWhiteSands } from './support/terrainField';

const SEED = 424242;
const SIGMAS = [0.05, 0.15];

function dtmZ(pts: { x: number; y: number; z: number }[]): Float32Array {
  return rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: WS_GRID, aggregation: 'mean' }).z;
}
const arr = (z: Float32Array): number[] => Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));

describe('XY-jitter perturbation moves the DTM/slope/aspect, reproducibly', () => {
  (hasWhiteSands() ? it : it.skip)('records seed/magnitude/hashes/metrics and grows the DTM change with σxy', () => {
    const base = readWhiteSandsGround();
    const inputHash = hashPoints(base);
    const baseZ = dtmZ(base);
    const baseDer = hornSlopeAspect(baseZ, WS_GRID.cols, WS_GRID.rows, WS_GRID.cellSizeM);

    const records = SIGMAS.map((sigma) => {
      const pert = perturbXY(base, SEED, sigma);
      const z = dtmZ(pert);
      const der = hornSlopeAspect(z, WS_GRID.cols, WS_GRID.rows, WS_GRID.cellSizeM);
      return {
        seed: SEED, sigma, inputHash, perturbedHash: hashPoints(pert),
        dtmRmse: gridErrorStats(arr(z), arr(baseZ), { nodata: NaN }).rmse,
        slopeRmse: gridErrorStats(Array.from(der.slope), Array.from(baseDer.slope), { nodata: NaN }).rmse,
        aspectMae: aspectErrorStats(Array.from(der.aspect), Array.from(baseDer.aspect)).mae,
      };
    });
    // eslint-disable-next-line no-console
    console.log('[terrain-field] xy jitter:', records.map((r) => `σxy=${r.sigma}:hash=${r.perturbedHash.slice(0, 8)},dtmRMSE=${r.dtmRmse.toExponential(2)},slopeRMSE=${r.slopeRmse.toExponential(2)}`).join('  '));

    // The perturbed set differs from the input, and the two magnitudes differ.
    expect(records[0].perturbedHash).not.toBe(inputHash);
    expect(records[1].perturbedHash).not.toBe(records[0].perturbedHash);
    // Larger jitter perturbs the DTM more (more points cross cell boundaries).
    expect(records[1].dtmRmse).toBeGreaterThan(records[0].dtmRmse);
  });

  (hasWhiteSands() ? it : it.skip)('same seed + magnitude reproduces the identical perturbed hash', () => {
    const base = readWhiteSandsGround();
    expect(hashPoints(perturbXY(base, SEED, 0.15))).toBe(hashPoints(perturbXY(base, SEED, 0.15)));
  });
});
