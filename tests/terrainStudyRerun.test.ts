/**
 * terrainStudyRerun.test.ts — quick-win 9. Deterministic re-run of one complete
 * terrain study.
 *
 * Runs the whole study — points → DTM → slope/aspect → contours → metrics →
 * ProcessPlan → evidence state → machine-readable report — twice in the same
 * process and requires the two runs to agree. Numeric grids are compared by
 * content hash (byte-exact), contour topology by level values and per-level
 * segment counts, and the report / ProcessPlan / evidence state by deep
 * equality. The study manifest (input hash, parameters, method versions) must be
 * identical too, so a re-run provably describes the same inputs and method.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import { gridErrorStats } from '../src/validation/terrainMetrics';
import { buildReport } from '../src/validation/terrainReport';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import { fnv1a } from '../src/canonicalHash';
import { hashPoints } from '../src/validation/terrainPerturbation';
import type { CrsInfo } from '../src/io/crs';
import type { ScanFacts } from '../src/process/ProcessPlan';
import { readWhiteSandsGround, readAsciiSouthUp, WS_GRID, WS_REF_BINCELL, hasWhiteSands } from './support/terrainField';

const STAMP = '2026-08-08T00:00:00.000Z'; // fixed, so the report is byte-stable

function hashGrid(a: Float32Array): string {
  let s = '';
  for (let i = 0; i < a.length; i++) s += Number.isFinite(a[i]) ? `${Math.round(a[i] * 1e6)};` : 'x;';
  return fnv1a(s);
}

const wsScan: ScanFacts = {
  kind: 'static', coverage: 'full',
  crs: { source: 'epsg', linearUnit: 'metre', linearUnitToMetres: 1 } as CrsInfo,
  pointCount: 46451, hasRgb: false, hasIntensity: true, hasGpsTime: false, hasReturnNumber: true,
  hasPointSourceId: false, classification: 'partial', groundClassified: true, hasBuildingClass: false, medianSpacing: 0.5,
};

/** The whole study as one deterministic object. */
function runStudy() {
  const pts = readWhiteSandsGround();
  const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { grid: WS_GRID, aggregation: 'mean' });
  const dtm = buildDtmGrid(raster);
  const der = hornSlopeAspect(dtm.z, dtm.cols, dtm.rows, dtm.cellSizeM);
  const contours = contoursAt(dtm, { intervalM: 0.5 });
  const ref = readAsciiSouthUp(WS_REF_BINCELL);
  const rawZ = raster.z; // measured cells only
  const metrics = gridErrorStats(
    Array.from(rawZ, (v) => (Number.isFinite(v) ? v : NaN)),
    Array.from(ref.z, (v) => (v === ref.nodata ? NaN : v)),
    { nodata: NaN },
  );
  const readiness = capabilityFor(evaluateCapabilities({ scans: [wsScan] }), 'dtm')!.readiness;
  const report = buildReport(
    [{ id: 'whitesands/scipy', title: 'DTM vs scipy point-in-cell', status: metrics.rmse < 0.01 ? 'pass' : 'fail', detail: `rmse=${metrics.rmse.toExponential(3)}` }],
    STAMP,
  );
  return {
    dtmHash: hashGrid(dtm.z),
    slopeHash: hashGrid(der.slope),
    aspectHash: hashGrid(der.aspect),
    contourTopology: contours.levels.map((l) => [l.value, l.segments.length]),
    metrics: { n: metrics.rmse, mae: metrics.mae, coverage: metrics.coverage },
    readiness,
    evidenceState: report.verdict,
    report,
    manifest: {
      inputHash: hashPoints(pts),
      grid: WS_GRID,
      params: { aggregation: 'mean', intervalM: 0.5 },
      method: { rasterize: 'point-in-cell mean', derivatives: 'horn-3x3' },
    },
  };
}

describe('deterministic re-run of a complete terrain study', () => {
  (hasWhiteSands() ? it : it.skip)('two runs agree byte-for-byte on grids, topology, metrics, plan, evidence and manifest', () => {
    const a = runStudy();
    const b = runStudy();
    // Numeric grids: byte-exact via content hash.
    expect(b.dtmHash).toBe(a.dtmHash);
    expect(b.slopeHash).toBe(a.slopeHash);
    expect(b.aspectHash).toBe(a.aspectHash);
    // Contour topology: same levels and same per-level segment counts.
    expect(b.contourTopology).toEqual(a.contourTopology);
    // Metrics, ProcessPlan, evidence state and the whole machine report.
    expect(b.metrics).toEqual(a.metrics);
    expect(b.readiness).toBe(a.readiness);
    expect(b.evidenceState).toBe(a.evidenceState);
    expect(b.report).toEqual(a.report);
    // The manifest identifies the same inputs, parameters and method versions.
    expect(b.manifest).toEqual(a.manifest);
  });
});
