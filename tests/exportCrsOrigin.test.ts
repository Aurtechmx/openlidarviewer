/**
 * exportCrsOrigin.test.ts: export provenance records where the coordinate
 * system came from (VLR, EVLR, or unknown), read from the resolved CRS.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { loadLas } from '../src/io/loadLas';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { sourceInterpretationOf } from '../src/science/sourceInterpretation';
import { crsOriginOf } from '../src/science/crsOrigin';
import { buildProcessingManifest, verifyProcessingManifest, type ProcessingManifest } from '../src/science/processingManifest';
import { exportGeoContext, type ReportExportDeps } from '../src/app/reportExport';
import { measurementsToGeoJSON } from '../src/export/measurementExport';
import { buildKml } from '../src/export/kmlExport';
import { buildObservatoryPackage } from '../src/export/observatoryPackage';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';
import { jsonOf, textOf } from './helpers/zipReader';
import type { Viewer } from '../src/render/Viewer';

const fixture = (name: string): ArrayBuffer => {
  const b = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function resolvedOf(name: string, fmt: 'las' | 'laz'): Promise<ResolvedCrs | null> {
  const cloud = await loadLas(fixture(name), fmt, name);
  return resolvedFromCrsInfo(cloud.metadata?.crs ?? undefined, 'las-vlr');
}

function geoFor(resolved: ResolvedCrs | null) {
  const cloud = { sourceOrigin: [0, 0, 0], name: 'site.las', pointCount: 1, declaredPointCount: 1, metadata: { interpretationLevel: 'VERIFIED' } };
  const viewer = { getCloud: () => cloud, streamingCloud: null } as unknown as Viewer;
  return exportGeoContext({
    getViewer: () => viewer,
    scans: { activeId: 'a', activeCloud: () => null },
    crsCurrent: () => resolved,
  } as unknown as ReportExportDeps);
}

const ctx = { toOutput: (p: readonly [number, number, number]) => [p[0], p[1], p[2]] as [number, number, number], up: [0, 0, 1] as [number, number, number], unitToMetres: 1 };
const dist = { id: 'd', kind: 'distance' as const, name: 'd', points: [[0, 0, 0], [3, 4, 0]] as [number, number, number][] };

function exportsFor(resolved: ResolvedCrs | null) {
  const geo = geoFor(resolved);
  const provenance = { generatedAt: '2026-01-01T00:00:00.000Z', source: 'site', crsName: geo.crsName ?? null, interpretation: geo.interpretation, crs: geo.crs };
  const geojson = JSON.parse(measurementsToGeoJSON([dist], { ...ctx, provenance }));
  const kml = buildKml({
    annotations: [], measurements: [], viewpoints: [], crsName: null, unitLabel: 'm',
    up: [0, 0, 1], unitToMetres: 1, toLonLat: (p) => [p[0], p[1], p[2]], notSurveyGradeNote: 'n',
    verticalDatum: null, provenance,
  });
  return { geojson, kml };
}

describe('CRS origin in export provenance', () => {
  it('EVLR: records las-evlr, the EPSG and the vertical datum source', async () => {
    const rc = await resolvedOf('evlr-crs-utm15.laz', 'laz');
    const { geojson, kml } = exportsFor(rc);
    expect(geojson.provenance.crsOrigin).toEqual({
      source: 'las-evlr', name: rc!.name, epsg: 'EPSG:6344', verticalDatum: 'EPSG:5703', verticalSource: 'las-evlr',
    });
    expect(kml).toContain('CRS source las-evlr (');
    expect(kml).toContain('vertical datum EPSG:5703 from las-evlr');
  });

  it('VLR: records las-vlr', async () => {
    const rc = await resolvedOf('terrain-access-utm.las', 'las');
    expect(rc).not.toBeNull();
    const { geojson, kml } = exportsFor(rc);
    expect(geojson.provenance.crsOrigin.source).toBe('las-vlr');
    expect(geojson.provenance.crsOrigin.epsg).toBe(rc!.epsg != null ? `EPSG:${rc!.epsg}` : 'unknown');
    expect(kml).toContain('CRS source las-vlr (');
  });

  it('unknown: a file with no CRS records "unknown" everywhere', async () => {
    const rc = await resolvedOf('tiny.las', 'las');
    expect(rc).toBeNull();
    const { geojson, kml } = exportsFor(rc);
    expect(geojson.provenance.crsOrigin).toEqual(crsOriginOf(null));
    expect(Object.values(geojson.provenance.crsOrigin)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    expect(kml).toContain('CRS source unknown (unknown, unknown); vertical datum unknown from unknown');
  });

  it('manifest op params and README lines carry the origin; verification still passes', async () => {
    const rc = await resolvedOf('evlr-crs-utm15.las', 'las');
    const rec = { ...sourceInterpretationOf('VERIFIED', 'full'), crsOrigin: crsOriginOf(rc) };
    const m = buildProcessingManifest({ build: 'b', source: 's', ops: [], sourceInterpretation: rec });
    expect(m.ops[0]!.params).toMatchObject({ crsOrigin: { source: 'las-evlr', epsg: 'EPSG:6344' } });
    expect(verifyProcessingManifest(JSON.parse(JSON.stringify(m))).ok).toBe(true);
    // Without a CRS read, the op is unchanged.
    const plain = buildProcessingManifest({ build: 'b', source: 's', ops: [], sourceInterpretation: sourceInterpretationOf('VERIFIED', 'full') });
    expect(plain.ops[0]!.params).toEqual({ interpretationLevel: 'VERIFIED', dataBasis: 'full' });
  });

  it('observatory package: manifest and README carry the run-time CRS origin', async () => {
    const rc = await resolvedOf('evlr-crs-utm15.las', 'las');
    const out = runObservatoryOverCloud(wallAndGroundCloud(), {
      voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 't', planning: false,
    });
    if (out.status !== 'ok') throw new Error('fixture refused');
    const zipOf = (crs: ResolvedCrs | null) =>
      buildObservatoryPackage(out.record, out.rows, [], { basename: 'o', interpretationLevel: 'VERIFIED', crs });
    const known = zipOf(rc);
    const m = jsonOf<ProcessingManifest>(known, 'o/processing-manifest.json');
    const op = m.ops.find((o) => o.method === 'olv.provenance.source-interpretation@1');
    expect(op?.params).toMatchObject({ crsOrigin: { source: 'las-evlr' } });
    expect(textOf(known, 'o/README.md')).toContain('CRS source las-evlr');
    expect(textOf(zipOf(null), 'o/README.md')).toContain('CRS source unknown');
  });
});
