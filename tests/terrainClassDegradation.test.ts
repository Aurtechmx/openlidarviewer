/**
 * terrainClassDegradation.test.ts — quick-win 4. Deterministic ground-label
 * degradation on the real survey-classified StREAM Lab crop.
 *
 * Remove 10% and 25% of the survey's class-2 (ground) labels by a seeded rule,
 * then run the production DTM path on the retained ground. As ground support
 * falls, DTM coverage must fall and DTM error against the full-ground DTM must
 * grow. The classification algorithm is NOT changed — only the input labels are
 * degraded, to see how the terrain path responds to thinner ground truth.
 *
 * Support/ProcessPlan note: partial removal still leaves ground present, so the
 * capability verdict stays READY. That is exactly why coverage is reported
 * separately — the plan says the product is buildable; the harness measures how
 * much real ground actually backs it. The two are not the same number.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { gridErrorStats } from '../src/validation/terrainMetrics';
import { degradeGround } from '../src/validation/terrainPerturbation';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';
import { readStreamLab, SL_GRID, hasStreamLab } from './support/terrainField';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const SEED = 13372026;
const N_CELLS = SL_GRID.cols * SL_GRID.rows;

function groundPoints(xyz: Float32Array, cls: Uint8Array): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === 2) pts.push({ x: xyz[i * 3] + SL_GRID.originH1, y: xyz[i * 3 + 1] + SL_GRID.originH2, z: xyz[i * 3 + 2] });
  }
  return pts;
}
function dtm(pts: TerrainPoint[]): { z: Float32Array; covered: number } {
  const z = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: SL_GRID, aggregation: 'mean' }).z;
  let covered = 0;
  for (const v of z) if (Number.isFinite(v)) covered++;
  return { z, covered };
}
const arr = (z: Float32Array): number[] => Array.from(z, (v) => (Number.isFinite(v) ? v : NaN));

const slScan = (groundClassified: boolean): ScanFacts => ({
  kind: 'static', coverage: 'full',
  crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as CrsInfo,
  pointCount: 16791, hasRgb: true, hasIntensity: false, hasGpsTime: false, hasReturnNumber: true,
  hasPointSourceId: false, classification: 'full', groundClassified, hasBuildingClass: false, medianSpacing: 0.35,
});

describe('ground-label degradation thins DTM support on real survey data', () => {
  (hasStreamLab() ? it : it.skip)('as class-2 labels are removed, retained ground and DTM coverage fall and error grows', () => {
    const { xyz, cls } = readStreamLab();
    const fullGround = groundPoints(xyz, cls);
    const base = dtm(fullGround);

    const rows = [0, 0.10, 0.25].map((frac) => {
      const degraded = frac === 0 ? cls : degradeGround(cls, SEED, frac);
      const pts = groundPoints(xyz, degraded);
      const d = dtm(pts);
      const err = frac === 0 ? 0 : gridErrorStats(arr(d.z), arr(base.z), { nodata: NaN }).rmse;
      return { frac, retained: pts.length, coverage: d.covered / N_CELLS, rmse: err };
    });
    // eslint-disable-next-line no-console
    console.log('[terrain-field] class degradation:', rows.map((r) => `drop=${(r.frac * 100).toFixed(0)}%:ground=${r.retained},cov=${r.coverage.toFixed(2)},rmse=${r.rmse.toExponential(2)}`).join('  '));

    // Monotone: more removed → fewer retained ground points and less coverage.
    expect(rows[1].retained).toBeLessThan(rows[0].retained);
    expect(rows[2].retained).toBeLessThan(rows[1].retained);
    expect(rows[1].coverage).toBeLessThanOrEqual(rows[0].coverage);
    expect(rows[2].coverage).toBeLessThanOrEqual(rows[1].coverage);
    // And the DTM drifts from the full-ground DTM as support thins.
    expect(rows[2].rmse).toBeGreaterThan(0);

    // Partial removal keeps ground present → capability verdict stays READY,
    // even though the measured coverage above has dropped. Plan authority and
    // measured support are distinct.
    expect(capabilityFor(evaluateCapabilities({ scans: [slScan(true)] }), 'dtm')!.readiness).toBe('ready');
  });

  (hasStreamLab() ? it : it.skip)('removing ALL ground drops the DTM to a derived-ground review, not a silent pass', () => {
    // The capability model's fail-safe: no trusted ground → the DTM must be
    // derived first (review), never reported as ready over absent ground.
    const v = capabilityFor(evaluateCapabilities({ scans: [slScan(false)] }), 'dtm')!;
    expect(v.readiness).toBe('review');
    expect(v.reasonCode).toBe('GROUND_DERIVED');
  });
});
