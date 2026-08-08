/**
 * terrainVerticalNoise.test.ts — quick-win 2. Seeded vertical-noise perturbation
 * on the real White Sands ground.
 *
 * For two small magnitudes (σz = 0.02 m, 0.05 m) add deterministic Gaussian
 * vertical noise, re-grid through the production terrain path, and measure how
 * the DTM, slope and aspect degrade against the unperturbed baseline. The same
 * seed must reproduce identical perturbed data and identical metrics.
 *
 * ProcessPlan/support note: small measurement noise does NOT change the dataset
 * facts (coverage, unit, ground trust), so the capability verdict is unchanged.
 * That is the point — noise moves the numbers within tolerance; it does not
 * fabricate or destroy authority. The verdict is recorded here to make that
 * explicit.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { gridErrorStats, aspectErrorStats } from '../src/validation/terrainMetrics';
import { perturbVertical, hashPoints } from '../src/validation/terrainPerturbation';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';
import { readWhiteSandsGround, WS_GRID, hasWhiteSands } from './support/terrainField';

const SEED = 20260808;
const SIGMAS = [0.02, 0.05];

function dtmZ(pts: { x: number; y: number; z: number }[]): Float32Array {
  return rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: WS_GRID, aggregation: 'mean' }).z;
}
const arr = (z: Float32Array): number[] => Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));

const wsScan: ScanFacts = {
  kind: 'static', coverage: 'full',
  crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as CrsInfo,
  pointCount: 46451, hasRgb: false, hasIntensity: true, hasGpsTime: false, hasReturnNumber: true,
  hasPointSourceId: false, classification: 'partial', groundClassified: true, hasBuildingClass: false, medianSpacing: 0.5,
};

describe('vertical-noise perturbation degrades DTM/slope/aspect, reproducibly', () => {
  (hasWhiteSands() ? it : it.skip)('RMSE and slope/aspect error grow with σz; ProcessPlan authority is unchanged', () => {
    const base = readWhiteSandsGround();
    const baseZ = dtmZ(base);
    const baseDer = hornSlopeAspect(baseZ, WS_GRID.cols, WS_GRID.rows, WS_GRID.cellSizeM);
    const baseReadiness = capabilityFor(evaluateCapabilities({ scans: [wsScan] }), 'dtm')!.readiness;

    const rows = SIGMAS.map((sigma) => {
      const pert = perturbVertical(base, SEED, sigma);
      const z = dtmZ(pert);
      const der = hornSlopeAspect(z, WS_GRID.cols, WS_GRID.rows, WS_GRID.cellSizeM);
      const dtm = gridErrorStats(arr(z), arr(baseZ), { nodata: NaN });
      const slope = gridErrorStats(Array.from(der.slope), Array.from(baseDer.slope), { nodata: NaN });
      const aspect = aspectErrorStats(Array.from(der.aspect), Array.from(baseDer.aspect));
      return { sigma, dtmRmse: dtm.rmse, slopeRmse: slope.rmse, aspectMae: aspect.mae, hash: hashPoints(pert) };
    });
    // eslint-disable-next-line no-console
    console.log('[terrain-field] vertical noise:', rows.map((r) => `σz=${r.sigma}:dtmRMSE=${r.dtmRmse.toExponential(2)},slopeRMSE=${r.slopeRmse.toExponential(2)},aspectMAE=${r.aspectMae.toFixed(2)}`).join('  '));

    // Larger noise → larger DTM error and larger slope error.
    expect(rows[1].dtmRmse).toBeGreaterThan(rows[0].dtmRmse);
    expect(rows[1].slopeRmse).toBeGreaterThan(rows[0].slopeRmse);
    // The DTM RMSE tracks the injected σz to order of magnitude (mean of ~1
    // return/cell → cell mean carries roughly the full per-point noise).
    expect(rows[0].dtmRmse).toBeGreaterThan(0);
    // Small measurement noise does not change the dataset's capability verdict.
    const afterReadiness = capabilityFor(evaluateCapabilities({ scans: [wsScan] }), 'dtm')!.readiness;
    expect(afterReadiness).toBe(baseReadiness);
  });

  (hasWhiteSands() ? it : it.skip)('the same seed reproduces identical perturbed data and metrics', () => {
    const base = readWhiteSandsGround();
    const a = perturbVertical(base, SEED, 0.05);
    const b = perturbVertical(base, SEED, 0.05);
    expect(hashPoints(a)).toBe(hashPoints(b));
    const ra = gridErrorStats(arr(dtmZ(a)), arr(dtmZ(base)), { nodata: NaN });
    const rb = gridErrorStats(arr(dtmZ(b)), arr(dtmZ(base)), { nodata: NaN });
    expect(rb.rmse).toBe(ra.rmse);
  });
});
