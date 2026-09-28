/**
 * reproduceFromProvenance.test.ts: read the provenance an export carries, re-run
 * the same method on the same fixture with only those recorded fields, and get
 * identical values. Covers a measured distance, a terrain DEM product and a
 * Flow Pulse run.
 */
import { describe, expect, it } from 'vitest';

import { measurementsToGeoJSON, measurementMetrics } from '../src/export/measurementExport';
import { sourceInterpretationOf } from '../src/science/sourceInterpretation';
import { computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import { runFlowPulse, FLOW_PULSE_DEFAULTS, type FlowPulseParams } from '../src/simulation/flowPulse/flowPulseRunner';
import type { ProcessingManifest } from '../src/science/processingManifest';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { textOf, jsonOf } from './helpers/zipReader';

const AT = '2026-01-01T00:00:00.000Z';

describe('Measure distance', () => {
  it('recomputes the exported length from the recorded geometry and CRS', () => {
    const m: Measurement = { id: 'd', kind: 'distance', name: 'd', points: [[1, 2, 3], [4, 6, 15]] };
    const ctx = {
      toOutput: (p: Vec3) => [p[0], p[1], p[2]] as [number, number, number],
      up: [0, 0, 1] as Vec3, unitToMetres: 1, crsName: 'EPSG:32612',
      provenance: { generatedAt: AT, source: 'site', crsName: 'EPSG:32612', interpretation: sourceInterpretationOf('VERIFIED', 'full') },
    };
    const fc = JSON.parse(measurementsToGeoJSON([m], ctx));
    expect(fc.provenance.crs).toBe('EPSG:32612');
    const f = fc.features[0];
    const again = measurementMetrics(
      { id: 'r', kind: f.properties.kind, name: 'r', points: f.geometry.coordinates },
      [0, 0, 1], 1,
    );
    expect(again.length_m).toBe(f.properties.length_m);
    expect(f.properties.length_m).toBe(13);
  });
});

function hill(n = 24, amp = 6): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  const c = (n - 1) / 2, s = (n - 1) / 3;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    pts.push({ x: i, y: j, z: amp * Math.exp(-(((i - c) ** 2 + (j - c) ** 2) / (2 * s * s))) });
  }
  return pts;
}

describe('terrain DEM product', () => {
  it('rebuilds a byte-identical DTM grid from the README cell size and manifest methods', () => {
    const basis = { analysedPointCount: 576, declaredPointCount: 576, coverage: 'full' as const, loadStride: null, interpretationLevel: 'VERIFIED' };
    const build = (cellSizeM: number) => buildDemPackage(
      contoursFromCore(computeTerrainCore(hill(), { cellSizeM, crs: 'EPSG:32610' }), { intervalM: 1 }),
      { basename: 'site', generationDateIso: AT, analysedBasis: basis },
    );
    const first = build(1);
    const readme = textOf(first, 'site-README.txt');
    expect(readme).toContain('Interpretation level: VERIFIED');
    expect(readme).toContain('Data basis: full');
    const cell = Number(/Cell size\s+([0-9.]+)/.exec(readme)![1]);
    expect(cell).toBe(1);
    const second = build(cell);
    expect(textOf(second, 'site-dtm.asc')).toBe(textOf(first, 'site-dtm.asc'));
  });
});

describe('Flow Pulse', () => {
  const dtm = () => flowDtmOf([[5, 5, 3, 5], [5, 4, 4, 5], [5, 4, 0, 5], [5, 5, 5, 5]]);

  it('re-runs from the recorded config and manifest to the same field digest and accumulation grid', () => {
    const params: FlowPulseParams = { ...FLOW_PULSE_DEFAULTS, conditioning: 'priority-flood', fillEpsilon: 0.01 };
    const run = runFlowPulse(dtm(), FLOW_PROJECTED_SCALE, params, FLOW_TEST_IDENTITY);
    if (!run.ok) throw new Error('fixture refused');
    const zip = buildFlowPulsePackage(run, {
      basename: 'f', generationDateIso: AT, sourceInterpretation: sourceInterpretationOf('VERIFIED', 'full'),
    });
    const config = jsonOf<Record<string, unknown>>(zip, 'f.olv-field-sim.json');
    const manifest = jsonOf<ProcessingManifest>(zip, 'f-processing-manifest.json');
    expect(manifest.ops[0]!.params).toEqual({ interpretationLevel: 'VERIFIED', dataBasis: 'full' });
    const again = runFlowPulse(dtm(), FLOW_PROJECTED_SCALE, {
      conditioning: config.conditioning as FlowPulseParams['conditioning'],
      routing: config.routing as FlowPulseParams['routing'],
      interpolated: config.interpolated as FlowPulseParams['interpolated'],
      fillEpsilon: config.fillEpsilon as number,
      fillNoData: config.fillNoData as FlowPulseParams['fillNoData'],
      maxCells: config.maxCells as number,
      withheldExcluded: run.basis.withheldExcluded,
    }, FLOW_TEST_IDENTITY);
    if (!again.ok) throw new Error('re-run refused');
    expect(again.record.result.fieldDigest).toBe(run.record.result.fieldDigest);
    const zip2 = buildFlowPulsePackage(again, { basename: 'f', generationDateIso: AT });
    expect(textOf(zip2, 'f-accumulation.asc')).toBe(textOf(zip, 'f-accumulation.asc'));
  });
});
