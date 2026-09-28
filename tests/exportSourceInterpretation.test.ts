/**
 * exportSourceInterpretation.test.ts: the probe interpretation level and the
 * data basis reach every export that writes provenance.
 */
import { describe, expect, it } from 'vitest';

import { sourceInterpretationOf, sourceInterpretationLines } from '../src/science/sourceInterpretation';
import {
  buildProcessingManifest,
  verifyProcessingManifest,
  type ProcessingManifest,
} from '../src/science/processingManifest';
import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import { runFlowPulse, FLOW_PULSE_DEFAULTS } from '../src/simulation/flowPulse/flowPulseRunner';
import { buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { buildObservatoryPackage } from '../src/export/observatoryPackage';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { measurementsToGeoJSON, measurementsToCsv } from '../src/export/measurementExport';
import { lightProvenance } from '../src/export/lightProvenance';
import { buildKml } from '../src/export/kmlExport';
import { buildFigureProvenance } from '../src/export/figureProvenance';
import { analysedBasisOf } from '../src/terrain/export/analysedBasis';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';
import { textOf, jsonOf } from './helpers/zipReader';

const SAMPLED_PROBABLE = sourceInterpretationOf('PROBABLE', 'sampled');

function interpretationOp(m: ProcessingManifest) {
  return m.ops.find((op) => op.method === 'olv.provenance.source-interpretation@1');
}

describe('sourceInterpretationOf', () => {
  it('keeps "not probed" apart from "not recorded"', () => {
    expect(sourceInterpretationOf(null, 'full')).toEqual({ interpretationLevel: 'not-probed', dataBasis: 'full' });
    expect(sourceInterpretationOf(undefined, undefined)).toEqual({ interpretationLevel: 'not-recorded', dataBasis: 'unknown' });
    expect(sourceInterpretationOf('VERIFIED', 'resident-only').dataBasis).toBe('resident-only');
    expect(sourceInterpretationOf('VERIFIED', 'partial').dataBasis).toBe('unknown');
  });

  it('prints two fixed README lines', () => {
    expect(sourceInterpretationLines(SAMPLED_PROBABLE)).toEqual([
      '  Interpretation level  PROBABLE',
      '  Data basis            sampled',
    ]);
  });

  it('analysedBasisOf carries the probe verdict only when given', () => {
    const facts = { coverage: 'full' as const, pointCount: 10 };
    expect('interpretationLevel' in analysedBasisOf(facts, 10)).toBe(false);
    expect(analysedBasisOf(facts, 10, 10, 'VERIFIED').interpretationLevel).toBe('VERIFIED');
  });
});

describe('processing manifest', () => {
  it('leads with the interpretation op and still verifies', () => {
    const m = buildProcessingManifest({ build: 'b', source: 's', ops: [], sourceInterpretation: SAMPLED_PROBABLE });
    expect(m.ops[0]).toMatchObject({
      seq: 0,
      method: 'olv.provenance.source-interpretation@1',
      params: { interpretationLevel: 'PROBABLE', dataBasis: 'sampled' },
    });
    expect(verifyProcessingManifest(JSON.parse(JSON.stringify(m))).ok).toBe(true);
  });

  it('is byte-identical to before when the record is omitted', () => {
    const a = buildProcessingManifest({ build: 'b', source: 's', ops: [] });
    const b = buildProcessingManifest({ build: 'b', source: 's', ops: [], sourceInterpretation: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.ops).toHaveLength(0);
  });
});

describe('Flow Pulse package', () => {
  const run = runFlowPulse(
    flowDtmOf([[5, 5, 5], [5, 1, 5], [5, 5, 5]]), FLOW_PROJECTED_SCALE, FLOW_PULSE_DEFAULTS, FLOW_TEST_IDENTITY,
  );
  if (!run.ok) throw new Error('fixture refused');

  it('writes the record into the manifest and README', () => {
    const zip = buildFlowPulsePackage(run, { basename: 'f', sourceInterpretation: SAMPLED_PROBABLE });
    const m = jsonOf<ProcessingManifest>(zip, 'f-processing-manifest.json');
    expect(interpretationOp(m)?.params).toEqual({ interpretationLevel: 'PROBABLE', dataBasis: 'sampled' });
    expect(verifyProcessingManifest(m).ok).toBe(true);
    expect(textOf(zip, 'f-README.txt')).toContain('Interpretation level  PROBABLE');
  });

  it('states "not-recorded" when the caller supplies nothing', () => {
    const zip = buildFlowPulsePackage(run, { basename: 'f' });
    expect(textOf(zip, 'f-README.txt')).toContain('Interpretation level  not-recorded');
  });
});

describe('Terrain Access package', () => {
  const n = 25;
  const dtm = {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: 5, rows: 5, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as unknown as DtmGrid;
  const profile: TerrainAccessProfile = {
    name: 'p', maxLongitudinalGrade: 1, maxCrossSlope: 1, maxStepHeight: 5, maxRuggedness: null,
    vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block',
    obstacleHeightThreshold: null,
  };
  const identity = {
    layerId: 'l', filename: 'site', sourceDigest: null, analysisInputDigest: 'x',
    build: 'b', id: 'r', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
  };
  const run = runTerrainAccess(
    dtm, { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true },
    profile, 0, 24, TERRAIN_ACCESS_DEFAULTS, identity,
  );
  if (!run.ok) throw new Error('fixture refused');

  it('writes the record into the manifest and README', () => {
    const zip = buildTerrainAccessPackage(run, { basename: 'ta', sourceInterpretation: SAMPLED_PROBABLE });
    const m = jsonOf<ProcessingManifest>(zip, 'ta-processing-manifest.json');
    expect(interpretationOp(m)?.params).toEqual({ interpretationLevel: 'PROBABLE', dataBasis: 'sampled' });
    expect(textOf(zip, 'ta-README.txt')).toContain('Data basis            sampled');
  });
});

describe('Observatory package', () => {
  const out = runObservatoryOverCloud(wallAndGroundCloud(), {
    voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 't', planning: false,
  });
  if (out.status !== 'ok') throw new Error('fixture refused');

  it('takes the level from the caller and the basis from the run record', () => {
    const zip = buildObservatoryPackage(out.record, out.rows, [], { basename: 'o', interpretationLevel: 'COMPATIBLE' });
    const m = jsonOf<ProcessingManifest>(zip, 'o/processing-manifest.json');
    expect(interpretationOp(m)?.params).toEqual({ interpretationLevel: 'COMPATIBLE', dataBasis: 'resident-only' });
    expect(textOf(zip, 'o/README.md')).toContain('Interpretation level  COMPATIBLE');
  });
});

describe('single-file vector exports', () => {
  const PROV_IN = {
    generatedAt: '2026-01-01T00:00:00.000Z',
    source: '/home/someone/private/site',
    crsName: 'EPSG:32612',
    interpretation: SAMPLED_PROBABLE,
  };
  const prov = lightProvenance(PROV_IN);

  it('never carries a directory part of the source name', () => {
    expect(prov.source).toBe('site');
    expect(JSON.stringify(prov)).not.toContain('/home');
  });

  const ctx = { toOutput: (p: readonly [number, number, number]) => [p[0], p[1], p[2]] as [number, number, number], up: [0, 0, 1] as [number, number, number], unitToMetres: 1, crsName: 'EPSG:32612' };
  const dist = { id: 'd', kind: 'distance' as const, name: 'd', points: [[0, 0, 0], [3, 4, 0]] as [number, number, number][] };

  it('measurement GeoJSON carries a provenance member; features are unchanged', () => {
    const withProv = JSON.parse(measurementsToGeoJSON([dist], { ...ctx, provenance: PROV_IN }));
    const without = JSON.parse(measurementsToGeoJSON([dist], ctx));
    expect(withProv.provenance).toMatchObject({
      software: 'OpenLiDARViewer', interpretationLevel: 'PROBABLE', dataBasis: 'sampled', crs: 'EPSG:32612', source: 'site',
    });
    expect(typeof withProv.provenance.version).toBe('string');
    expect(typeof withProv.provenance.commit).toBe('string');
    expect(withProv.features).toEqual(without.features);
    expect('provenance' in without).toBe(false);
  });

  it('measurement CSV is unchanged (no metadata slot)', () => {
    expect(measurementsToCsv([dist], { ...ctx, provenance: PROV_IN })).toBe(measurementsToCsv([dist], ctx));
  });

  it('KML document description carries the provenance line', () => {
    const kml = buildKml({
      annotations: [], measurements: [], viewpoints: [], crsName: 'EPSG:32612', unitLabel: 'm',
      up: [0, 0, 1], unitToMetres: 1, toLonLat: (p) => [p[0], p[1], p[2]], notSurveyGradeNote: 'n',
      verticalDatum: null, provenance: PROV_IN,
    });
    expect(kml).toContain('interpretation level PROBABLE; data basis sampled.');
  });

  it('PNG figure chunks carry the level and basis when known', () => {
    const entries = buildFigureProvenance({ build: 'b', timestamp: 't', sourceInterpretation: SAMPLED_PROBABLE });
    expect(entries).toContainEqual({ keyword: 'olv:interpretation-level', text: 'PROBABLE' });
    expect(entries).toContainEqual({ keyword: 'olv:data-basis', text: 'sampled' });
    const none = buildFigureProvenance({ build: 'b', timestamp: 't' });
    expect(none.some((e) => e.keyword.startsWith('olv:interp'))).toBe(false);
  });
});
