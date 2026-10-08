/**
 * exportInputDigests.test.ts: every provenance-carrying export records the
 * source-file SHA-256 (or why it is absent), the analysis-input SHA-256 where
 * the export comes from an analysis, and the CRS origin.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';

import { pointsSha256 } from '../src/science/pointsSha256';
import {
  exportDigests,
  exportDigestLines,
  INPUT_NOT_RECORDED_NOTE,
  SOURCE_NOT_SUPPLIED_NOTE,
  STREAMED_SOURCE_NOTE,
  SOURCE_NOT_HELD_NOTE,
  SOURCE_NOT_COMPUTED_NOTE,
  type ExportDigests,
} from '../src/science/exportDigestRecord';
import { crsOriginOf } from '../src/science/crsOrigin';
import { sourceDigestOf, resolveExportDigests } from '../src/export/exportDigests';
import { rememberCloudFile } from '../src/io/sourceFiles';
import { markStreamedCloud } from '../src/io/streamedClouds';
import { convertCloud } from '../src/convert/convertCloud';
import { runBatch } from '../src/convert/convertRunner';
import { residentPositionsDigest } from '../src/app/residentPositionsDigest';
import { analyseContours, computeTerrainCore, contoursFromCore } from '../src/terrain/contour/analyseContours';
import { encodeTerrainCore, decodeTerrainCore } from '../src/terrain/contour/terrainCorePayload';
import { buildExportProvenance, provenanceJson, provenanceLines } from '../src/terrain/export/exportProvenance';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { unsafeEntryName } from '../src/export/safeText';
import { buildZip } from '../src/convert/zipStore';
import { buildStudioPngPackage } from '../src/render/export/pngWorldFile';
import { buildContourDeliverableFromResult } from '../src/terrain/export/contourDeliverableBuild';
import { buildTerrainReportContent } from '../src/terrain/export/terrainReportContent';
import { buildMapSheetPdf } from '../src/render/measure/mapSheetPdf';
import { toXyz, toCsv, toPly, toObj, exportCloud } from '../src/io/exporters';
import { PointCloud } from '../src/model/PointCloud';
import { measurementsToGeoJSON } from '../src/export/measurementExport';
import { integrityReportFile } from '../src/export/measurementReport';
import { buildKml } from '../src/export/kmlExport';
import { buildFigureProvenance } from '../src/export/figureProvenance';
import { buildObservatoryPackage } from '../src/export/observatoryPackage';
import { runObservatoryOverCloud } from '../src/app/observatoryFromCloud';
import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import { runFlowPulse, FLOW_PULSE_DEFAULTS } from '../src/simulation/flowPulse/flowPulseRunner';
import { buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { buildDatasetSummary } from '../src/report/ReportMetadataSection';
import { exportGeoContext, type ReportExportDeps } from '../src/app/reportExport';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { Viewer } from '../src/render/Viewer';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { wallAndGroundCloud } from './helpers/observatoryPlanningFixtures';
import { DTM_CLAIMS, validatedDecision } from './helpers/exportDecisions';
import { extractEntry, jsonOf, textOf } from './helpers/zipReader';

const SHA = createHash('sha256').update('source bytes').digest('hex');
const CRS = { source: 'las-vlr', name: 'NAD83(2011) / UTM zone 15N', epsg: 6344, verticalEpsg: 5703 };
const D: ExportDigests = exportDigests({ sha256: SHA, note: null }, CRS);
const ORIGIN_LINE = 'CRS source las-vlr (NAD83(2011) / UTM zone 15N, EPSG:6344); vertical datum EPSG:5703 from las-vlr';

/** Node's SHA-256 over the same little-endian float32 bytes `pointsSha256` reads. */
function nodePointsSha(values: readonly number[]): string {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return createHash('sha256').update(buf).digest('hex');
}

function hill(): Float32Array {
  const pos: number[] = [];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) pos.push(i, j, 3 * Math.exp(-((i - 15) ** 2 + (j - 15) ** 2) / 80));
  return new Float32Array(pos);
}
const PARAMS = { intervalM: 0.5, cellSizeM: 1, horizontalUnitToMetres: 1, verticalUnitToMetres: 1 } as const;

describe('pointsSha256', () => {
  it('is SHA-256 of the little-endian float32 bytes, in order', () => {
    const v = [1.5, -2, 3.25, 1e6, 0, -0.125];
    expect(pointsSha256(new Float32Array(v))).toBe(nodePointsSha(v));
  });

  it('is deterministic and order-sensitive', () => {
    const a = hill();
    expect(pointsSha256(a)).toBe(pointsSha256(new Float32Array(a)));
    const swapped = new Float32Array(a);
    swapped.set(a.subarray(3, 6), 0);
    swapped.set(a.subarray(0, 3), 3);
    expect(pointsSha256(swapped)).not.toBe(pointsSha256(a));
  });

  it('crosses the chunk boundary without changing the bytes hashed', () => {
    const v = Array.from({ length: 64 * 1024 * 2 + 7 }, (_, i) => (i % 97) * 0.5);
    expect(pointsSha256(new Float32Array(v))).toBe(nodePointsSha(v));
  });

  it('is the digest the Observatory records for its resident positions', () => {
    const a = hill();
    expect(residentPositionsDigest(a)).toBe(pointsSha256(a));
  });
});

describe('analysis-input digest on the terrain core', () => {
  it('covers the exact positions the core read, and survives the persisted payload', () => {
    const pos = hill();
    const core = computeTerrainCore(pos, PARAMS);
    expect(core.inputSha256).toBe(pointsSha256(pos));
    expect(contoursFromCore(core, PARAMS).inputSha256).toBe(core.inputSha256);
    const decoded = decodeTerrainCore(encodeTerrainCore(core)!);
    if (!('core' in decoded)) throw new Error('payload did not decode');
    expect(decoded.core.inputSha256).toBe(core.inputSha256);
  });

  it('is the same for a TerrainPoint[] input of the same points', () => {
    const pos = hill();
    const pts = Array.from({ length: pos.length / 3 }, (_, i) => ({ x: pos[i * 3]!, y: pos[i * 3 + 1]!, z: pos[i * 3 + 2]! }));
    expect(computeTerrainCore(pts, PARAMS).inputSha256).toBe(pointsSha256(pos));
  });

  it('determinism: the same input gives the same digest; a clipped input a different one', () => {
    const a = analyseContours(hill(), PARAMS);
    const b = analyseContours(hill(), PARAMS);
    expect(a.inputSha256).toBe(b.inputSha256);
    const clipped = hill().subarray(0, 3 * 600);
    expect(analyseContours(new Float32Array(clipped), PARAMS).inputSha256).not.toBe(a.inputSha256);
  });
});

describe('source-file digest resolution', () => {
  it('a streamed source states it is not available; nothing is invented', async () => {
    expect(await sourceDigestOf({ key: {}, streamed: true })).toEqual({ sha256: null, note: STREAMED_SOURCE_NOTE });
  });

  it('a cloud with no held File states so', async () => {
    expect(await sourceDigestOf({ key: {}, streamed: false })).toEqual({ sha256: null, note: SOURCE_NOT_HELD_NOTE });
    expect(await sourceDigestOf(null)).toEqual({ sha256: null, note: SOURCE_NOT_HELD_NOTE });
  });

  it('hashes the original bytes of a held File, once per File', async () => {
    const bytes = new TextEncoder().encode('source bytes');
    const key = {};
    rememberCloudFile(key, new File([bytes], 'site.las'));
    expect(await sourceDigestOf({ key, streamed: false })).toEqual({ sha256: SHA, note: null });
    let calls = 0;
    const key2 = {};
    rememberCloudFile(key2, new File([bytes], 'b.las'));
    const counted = async (): Promise<string | null> => { calls++; return 'f'.repeat(64); };
    await sourceDigestOf({ key: key2, streamed: false }, counted);
    await sourceDigestOf({ key: key2, streamed: false }, counted);
    expect(calls).toBe(1);
  });

  it('a failed read records "not computed", never a value', async () => {
    const key = {};
    rememberCloudFile(key, new File([new Uint8Array(4)], 'c.las'));
    expect(await sourceDigestOf({ key, streamed: false }, async () => null)).toEqual({ sha256: null, note: SOURCE_NOT_COMPUTED_NOTE });
  });

  it('resolveExportDigests carries the CRS origin', async () => {
    const d = await resolveExportDigests({ key: {}, streamed: true }, CRS);
    expect(d.crsOrigin).toEqual(crsOriginOf(CRS));
    expect('analysisInputSha256' in d).toBe(false);
    expect(exportDigestLines(d)).toEqual([`Source SHA-256: ${STREAMED_SOURCE_NOTE}`, ORIGIN_LINE]);
  });

  it('exportGeoContext names the static cloud or the stream as the source', () => {
    const cloud = { sourceOrigin: [0, 0, 0], name: 'a.las', pointCount: 1 };
    const geo = (staticCloud: unknown, streaming: unknown) => exportGeoContext({
      getViewer: () => ({ getCloud: () => staticCloud, streamingCloud: streaming }) as unknown as Viewer,
      scans: { activeId: staticCloud ? 'a' : null, activeCloud: () => null },
      crsCurrent: () => null,
    } as unknown as ReportExportDeps);
    expect(geo(cloud, null).source).toEqual({ key: cloud, streamed: false });
    const sc = { renderOrigin: [0, 0, 0], name: 's.copc.laz' };
    expect(geo(null, sc).source).toEqual({ key: sc, streamed: true });
  });
});

describe('point-cloud exports', () => {
  const cloud = new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 1, 1]), origin: [0, 0, 0], sourceOrigin: [0, 0, 0], sourceFormat: 'las', name: 'site.las',
  } as unknown as ConstructorParameters<typeof PointCloud>[0]);

  it('XYZ, PLY and OBJ carry the source digest and CRS origin as comments', () => {
    expect(toXyz(cloud, ' ', undefined, D)).toContain(`# Source SHA-256: ${SHA}\n# ${ORIGIN_LINE}\n`);
    expect(toPly(cloud, undefined, D)).toContain(`comment Source SHA-256: ${SHA}\ncomment ${ORIGIN_LINE}\n`);
    expect(toObj(cloud, undefined, D)).toContain(`# Source SHA-256: ${SHA}\n# ${ORIGIN_LINE}\n`);
    expect(exportCloud(cloud, 'ply', undefined, D)).toBe(toPly(cloud, undefined, D));
  });

  it('only the provenance lines change; CSV has no comment slot and is unchanged', () => {
    const strip = (t: string) => t.split('\n').filter((l) => !l.includes('SHA-256') && !l.includes('CRS source')).join('\n');
    expect(strip(toPly(cloud, undefined, D))).toBe(toPly(cloud));
    expect(strip(toXyz(cloud, ' ', undefined, D))).toBe(toXyz(cloud));
    expect(exportCloud(cloud, 'csv', undefined, D)).toBe(toCsv(cloud));
  });
});

describe('measurement exports', () => {
  const dist = { id: 'd', kind: 'distance' as const, name: 'd', points: [[0, 0, 0], [3, 4, 0]] as [number, number, number][] };
  const provenance = { generatedAt: '2026-01-01T00:00:00.000Z', source: 'site', crsName: 'UTM', crs: CRS, digests: D };

  it('GeoJSON provenance records the source digest beside the CRS origin', () => {
    const fc = JSON.parse(measurementsToGeoJSON([dist], {
      toOutput: (p) => [p[0], p[1], p[2]], up: [0, 0, 1], unitToMetres: 1, provenance,
    } as Parameters<typeof measurementsToGeoJSON>[1]));
    expect(fc.provenance.sourceSha256).toBe(SHA);
    expect(fc.provenance.sourceSha256Note).toBeNull();
    expect(fc.provenance.crsOrigin.epsg).toBe('EPSG:6344');
  });

  it('a streamed source is stated in the GeoJSON and KML', () => {
    const streamed = { ...provenance, digests: exportDigests({ sha256: null, note: STREAMED_SOURCE_NOTE }, CRS) };
    const fc = JSON.parse(measurementsToGeoJSON([dist], {
      toOutput: (p) => [p[0], p[1], p[2]], up: [0, 0, 1], unitToMetres: 1, provenance: streamed,
    } as Parameters<typeof measurementsToGeoJSON>[1]));
    expect(fc.provenance).toMatchObject({ sourceSha256: null, sourceSha256Note: STREAMED_SOURCE_NOTE });
    const kml = buildKml({
      annotations: [], measurements: [], viewpoints: [], crsName: null, unitLabel: 'm', up: [0, 0, 1], unitToMetres: 1,
      toLonLat: (p) => [p[0], p[1], p[2]], notSurveyGradeNote: 'n', verticalDatum: null, provenance: streamed,
    } as Parameters<typeof buildKml>[0]);
    expect(kml).toContain(`source SHA-256 ${STREAMED_SOURCE_NOTE}; CRS UTM; CRS source las-vlr`);
  });

  it('a caller that resolved nothing says so rather than leaving the field out', () => {
    const fc = JSON.parse(measurementsToGeoJSON([dist], {
      toOutput: (p) => [p[0], p[1], p[2]], up: [0, 0, 1], unitToMetres: 1, provenance: { generatedAt: 't', source: 's', crsName: null },
    } as Parameters<typeof measurementsToGeoJSON>[1]));
    expect(fc.provenance).toMatchObject({ sourceSha256: null, sourceSha256Note: SOURCE_NOT_SUPPLIED_NOTE });
  });

  it('the signed integrity report carries the digest and CRS origin under dataset', () => {
    const f = integrityReportFile([dist], [0, 0, 1], 1, 1, 'site', 'UTM', '2026-01-01T00:00:00.000Z', 0, 'v', true, undefined, D);
    const m = JSON.parse(f.text);
    expect(m.dataset).toMatchObject({ sourceSha256: SHA, sourceSha256Note: null, crsOrigin: { source: 'las-vlr' } });
  });
});

describe('figure PNG chunks', () => {
  it('records the source digest and CRS origin', () => {
    const entries = buildFigureProvenance({ build: 'b', timestamp: 't', digests: D });
    expect(entries).toContainEqual({ keyword: 'olv:source-sha256', text: SHA });
    expect(entries).toContainEqual({ keyword: 'olv:crs-origin', text: ORIGIN_LINE });
    expect(buildFigureProvenance({ build: 'b', timestamp: 't' }).some((e) => e.keyword === 'olv:source-sha256')).toBe(false);
  });
});

describe('terrain exports', () => {
  const result = analyseContours(hill(), PARAMS);
  const input = pointsSha256(hill());

  it('provenance lines and JSON carry all three fields', () => {
    const p = buildExportProvenance(result, { verticalUnitToMetres: 1, digests: D });
    const lines = provenanceLines(p).join('\n');
    expect(lines).toContain(`Source SHA-256    ${SHA}`);
    expect(lines).toContain(`Input SHA-256     ${input}`);
    expect(lines).toContain(`CRS origin        ${ORIGIN_LINE}`);
    expect(provenanceJson(p)).toMatchObject({ sourceSha256: SHA, sourceSha256Note: null, analysisInputSha256: input, crsOrigin: crsOriginOf(CRS) });
  });

  it('without digests the record states that rather than omitting the fields', () => {
    const p = buildExportProvenance(result, { verticalUnitToMetres: 1 });
    expect(p.sourceSha256).toBeNull();
    expect(p.sourceSha256Note).toBe(SOURCE_NOT_SUPPLIED_NOTE);
    const old = { ...result, inputSha256: undefined };
    expect(provenanceLines(buildExportProvenance(old, { verticalUnitToMetres: 1 })).join('\n')).toContain(`Input SHA-256     ${INPUT_NOT_RECORDED_NOTE}`);
  });

  it('DEM package: README block and the DTM passport source digest', () => {
    const zip = buildDemPackage(result, { basename: 'site', linearUnit: 'metre', digests: D, generationDateIso: '2026-01-01T00:00:00.000Z' });
    const readme = textOf(zip, 'site-README.txt');
    expect(readme).toContain(`Source SHA-256    ${SHA}`);
    expect(readme).toContain(`Input SHA-256     ${input}`);
    expect(readme).toContain(ORIGIN_LINE);
    expect(jsonOf<{ source: { sha256: string } }>(zip, 'site-dtm.tif.olv-passport.json').source.sha256).toBe(SHA);
  });

  it('complete deliverable ZIP: provenance JSON', () => {
    const zip = buildContourDeliverableFromResult(result, {
      decision: validatedDecision(DTM_CLAIMS), basename: 'site', isGeographic: false, softwareVersion: 'v', metricVersion: 'm',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'), exportPermit: null, digests: D,
    });
    const prov = JSON.parse(new TextDecoder().decode(extractEntry(zip, 'site_Provenance.json')!));
    expect(prov).toMatchObject({ sourceSha256: SHA, analysisInputSha256: input, crsOrigin: { epsg: 'EPSG:6344' } });
  });

  it('terrain report: provenance footer lines', () => {
    const c = buildTerrainReportContent(result, { verticalUnitToMetres: 1, digests: D });
    expect(c.provenanceLines.join('\n')).toContain(`Input SHA-256     ${input}`);
  });

  it('map sheet PDF: Info dictionary Subject', async () => {
    const provenance = buildExportProvenance(result, { verticalUnitToMetres: 1, digests: D });
    const bytes = await buildMapSheetPdf({ model: result.model, labels: result.labels, provenance, generatedAt: new Date('2026-01-01T00:00:00.000Z') } as Parameters<typeof buildMapSheetPdf>[0]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getSubject()).toBe(`Source SHA-256: ${SHA}; Input SHA-256: ${input}; ${ORIGIN_LINE}`);
  });
});

/** The wall-and-ground Observatory run the package tests share. */
function observatoryRun() {
  const out = runObservatoryOverCloud(wallAndGroundCloud(), {
    voxelEdge: 0.5, declaredStepBudget: 50_000_000, filename: 'wall.ptx', metresPerUnit: 1, buildTag: 't', planning: false,
  });
  if (out.status !== 'ok') throw new Error('fixture refused');
  return out;
}

/** A small sink DTM run through Flow Pulse. */
function flowRun() {
  const run = runFlowPulse(flowDtmOf([[5, 5, 5], [5, 1, 5], [5, 5, 5]]), FLOW_PROJECTED_SCALE, FLOW_PULSE_DEFAULTS, FLOW_TEST_IDENTITY);
  if (!run.ok) throw new Error('fixture refused');
  return run;
}

/** A 5 by 5 flat DTM run through Terrain Access, for the package tests. */
function terrainAccessRun() {
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
    vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block', obstacleHeightThreshold: null,
  };
  const identity = {
    layerId: 'l', filename: 'site', sourceDigest: null, analysisInputDigest: 'x',
    build: 'b', id: 'r', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
  };
  const run = runTerrainAccess(dtm, { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true }, profile, 0, 24, TERRAIN_ACCESS_DEFAULTS, identity);
  if (!run.ok) throw new Error('fixture refused');
  return run;
}

describe('analysis packages', () => {
  it('Observatory: source digest, analysis input digest and passport', () => {
    const out = observatoryRun();
    const zip = buildObservatoryPackage(out.record, out.rows, [], { basename: 'o', crs: CRS, sourceSha256: SHA });
    const readme = textOf(zip, 'o/README.md');
    expect(readme).toContain(`Analysis input SHA-256  ${out.record.source.analysisInputSha256}`);
    expect(readme).toContain(`Source SHA-256  ${SHA}`);
    expect(readme).toContain(ORIGIN_LINE);
    expect(jsonOf<{ source: { sha256: string } }>(zip, 'o/scientific-passport.json').source.sha256).toBe(SHA);
    const streamed = buildObservatoryPackage(out.record, out.rows, [], { basename: 'o', sourceSha256Note: STREAMED_SOURCE_NOTE });
    expect(textOf(streamed, 'o/README.md')).toContain(`Source SHA-256  ${STREAMED_SOURCE_NOTE}`);
  });

  it('Flow Pulse: README, manifest CRS origin and passport', () => {
    const run = flowRun();
    const zip = buildFlowPulsePackage(run, { basename: 'f', digests: D });
    const readme = textOf(zip, 'f-README.txt');
    expect(readme).toContain(`Source SHA-256 ${SHA}`);
    expect(readme).toContain(`Input digest   ${run.record.source.analysisInputDigest}`);
    expect(readme).toContain(ORIGIN_LINE);
    expect(JSON.stringify(jsonOf(zip, 'f-processing-manifest.json'))).toContain('"crsOrigin"');
    expect(jsonOf<{ source: { sha256: string } }>(zip, 'f-scientific-artifact-passport.json').source.sha256).toBe(SHA);
  });

  it('Terrain Access: README and passport', () => {
    const run = terrainAccessRun();
    const zip = buildTerrainAccessPackage(run, { basename: 'ta', digests: D });
    expect(textOf(zip, 'ta-README.txt')).toContain(`Source SHA-256 ${SHA}`);
    expect(textOf(zip, 'ta-README.txt')).toContain(ORIGIN_LINE);
    expect(jsonOf<{ source: { sha256: string } }>(zip, 'ta-scientific-artifact-passport.json').source.sha256).toBe(SHA);
    const none = buildTerrainAccessPackage(run, { basename: 'ta' });
    expect(textOf(none, 'ta-README.txt')).toContain(`Source SHA-256 ${SOURCE_NOT_SUPPLIED_NOTE}`);
  });
});

describe('scan PDF report', () => {
  it('dataset summary rows', () => {
    const rows = buildDatasetSummary({
      fileName: 'a.las', format: 'LAS', sourcePointCount: 1, width: 1, depth: 1, height: 1, density: 1,
      hasRgb: false, hasIntensity: false, hasClassification: false, digests: D,
    });
    expect(rows).toContainEqual({ label: 'Source SHA-256', value: SHA });
    expect(rows).toContainEqual({ label: 'CRS origin', value: 'las-vlr, EPSG:6344; vertical datum EPSG:5703 from las-vlr' });
  });
});

/** The LASF_Spec Text Area Description payload and its VLR description field. */
function textArea(las: Uint8Array): { text: string; label: string } | null {
  const view = new DataView(las.buffer, las.byteOffset, las.byteLength);
  let p = view.getUint16(94, true);
  const n = view.getUint32(100, true);
  const str = (from: number, len: number) => {
    let out = '';
    for (let k = 0; k < len && las[from + k] !== 0; k++) out += String.fromCharCode(las[from + k]!);
    return out;
  };
  for (let i = 0; i < n; i++) {
    const recLen = view.getUint16(p + 20, true);
    if (str(p + 2, 16) === 'LASF_Spec' && view.getUint16(p + 18, true) === 3) {
      return { text: str(p + 54, recLen), label: str(p + 22, 32) };
    }
    p += 54 + recLen;
  }
  return null;
}

const QUANTISATION = 'Scale/offset: re-quantised (the source scale and offset are not recorded for this cloud).';

describe('point re-save (convert)', () => {
  const BASIS = 'Point basis: full file (2 points)';
  const EDITS = 'Classes edited in app: no';
  const cloud = () => new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1]), origin: [500000, 4000000, 100], sourceFormat: 'las', name: 'survey.las',
  } as unknown as ConstructorParameters<typeof PointCloud>[0]);

  it('LAS 1.2 and 1.4 carry the lines in the Text Area Description', () => {
    for (const format of ['las', 'las14'] as const) {
      const { file } = convertCloud(cloud(), { format, digests: D });
      const ta = textArea(file!.bytes);
      expect(ta?.label).toBe('OpenLiDARViewer provenance');
      expect(ta?.text).toBe(`Source SHA-256: ${SHA}\n${ORIGIN_LINE}\n${BASIS}\n${EDITS}\n${QUANTISATION}`);
    }
  });

  it('XYZ and ASC carry them as comment lines; without digests only the basis lines remain', () => {
    const dec = (f: { bytes: Uint8Array }) => new TextDecoder().decode(f.bytes);
    const xyz = dec(convertCloud(cloud(), { format: 'xyz', digests: D }).file!);
    expect(xyz).toContain(`# Source file: survey.las\n# Source SHA-256: ${SHA}\n# ${ORIGIN_LINE}\n`);
    const asc = dec(convertCloud(cloud(), { format: 'asc', digests: D }).file!);
    expect(asc).toContain(`# Source SHA-256: ${SHA}\n# ${ORIGIN_LINE}\n# ${BASIS}\n# ${EDITS}\n# columns:`);
    const plain = convertCloud(cloud(), { format: 'las' }).file!.bytes;
    expect(textArea(plain)?.text).toBe(`${BASIS}\n${EDITS}\n${QUANTISATION}`);
    expect(dec(convertCloud(cloud(), { format: 'xyz' }).file!)).not.toContain('SHA-256');
  });

  it('a clipped export states the clip after the digests', () => {
    const note = 'Clipped: 2 of 5 points';
    const las = convertCloud(cloud(), { format: 'las', digests: D, scopeNote: note }).file!;
    expect(textArea(las.bytes)?.text).toBe(`Source SHA-256: ${SHA}\n${ORIGIN_LINE}\n${BASIS}\n${note}\n${EDITS}\n${QUANTISATION}`);
    const xyz = new TextDecoder().decode(convertCloud(cloud(), { format: 'xyz', scopeNote: note }).file!.bytes);
    expect(xyz).toContain(`# ${BASIS}\n# ${note}\n# ${EDITS}\n`);
  });

  it('the batch converter hashes each input file\'s own bytes', async () => {
    const bytes = new TextEncoder().encode('source bytes');
    const [r] = await runBatch(
      [{ name: 'a.las', sizeBytes: bytes.length, bytes: async () => bytes.slice().buffer }],
      { format: 'xyz' },
      async () => cloud(),
    );
    expect(new TextDecoder().decode(r!.file!.bytes)).toContain(`# Source SHA-256: ${SHA}\n`);
  });

  it('a streamed snapshot cloud states the digest is not available', async () => {
    const snap = {};
    markStreamedCloud(snap);
    expect(await sourceDigestOf({ key: snap, streamed: false })).toEqual({ sha256: null, note: STREAMED_SOURCE_NOTE });
  });
});

describe('multi-source, cancellation and record names', () => {
  const bytesOf = (s: string) => new TextEncoder().encode(s);

  it('H1: a terrain analysis over several inputs records no single source digest', async () => {
    const { sampleStridedTerrain } = await import('../src/render/terrainStreamSample');
    const { contoursFromCore: fromCache } = await import('../src/terrain/contour/terrainCoreCache');
    const { analysisSourceDigest, MULTIPLE_SOURCES_NOTE } = await import('../src/export/exportDigests');
    const a = hill(); const b = hill().map((v) => v + 100);
    rememberCloudFile({}, new File([bytesOf('a')], 'a.las'), a);
    rememberCloudFile({}, new File([bytesOf('b')], 'b.las'), b);
    const one = sampleStridedTerrain([{ pos: a }], [], a.length / 3, 1e6, false)!;
    const two = sampleStridedTerrain([{ pos: a }, { pos: b }], [], (a.length + b.length) / 3, 1e6, false)!;
    const mixed = sampleStridedTerrain([{ pos: a }], [{ key: '0-0-0-0', pos: b }], (a.length + b.length) / 3, 1e6, false)!;
    const { registerCoreInputs } = await import('../src/terrain/contour/terrainCoreCache');
    // One core, copied per sample so each copy carries its own inputs.
    const core = computeTerrainCore(hill(), PARAMS);
    const resultOf = (positions: Float32Array) => fromCache(registerCoreInputs({ ...core }, positions), PARAMS);
    expect(await analysisSourceDigest(resultOf(one.positions), null)).toEqual({ sha256: createHash('sha256').update('a').digest('hex'), note: null });
    expect(await analysisSourceDigest(resultOf(two.positions), null)).toEqual({ sha256: null, note: MULTIPLE_SOURCES_NOTE(2, false) });
    expect((await analysisSourceDigest(resultOf(mixed.positions), null)).note).toBe(MULTIPLE_SOURCES_NOTE(2, true));
  });

  it('L2: no recorded inputs and no cloud is "not computed", never "streamed"', async () => {
    const { analysisSourceDigest } = await import('../src/export/exportDigests');
    expect(await analysisSourceDigest({}, null)).toEqual({ sha256: null, note: SOURCE_NOT_COMPUTED_NOTE });
  });

  it('L1: an aborted hash is not computed and is not cached', async () => {
    const key = {};
    rememberCloudFile(key, new File([bytesOf('source bytes')], 'x.las'));
    const ac = new AbortController(); ac.abort();
    expect((await sourceDigestOf({ key, streamed: false }, undefined, ac.signal)).note).toBe('not computed: the hash was cancelled');
    expect((await sourceDigestOf({ key, streamed: false })).sha256).toBe(SHA);
  });

  it('a cancelled hash is not reused: the next export gets the digest', async () => {
    const { SOURCE_CANCELLED_NOTE } = await import('../src/science/exportDigestRecord');
    const key = {};
    rememberCloudFile(key, new File([bytesOf('source bytes')], 'y.las'));
    const ac = new AbortController();
    const slow = (_f: File, signal?: AbortSignal) => new Promise<string | null>((res) => signal?.addEventListener('abort', () => res(null)));
    const first = sourceDigestOf({ key, streamed: false }, slow, ac.signal);
    ac.abort();
    const second = sourceDigestOf({ key, streamed: false });
    expect(await first).toEqual({ sha256: null, note: SOURCE_CANCELLED_NOTE });
    expect((await second).sha256).toBe(SHA);
  });

  it('N1: the Observatory record names its digest analysisInputSha256; an old record still reads', () => {
    const out = observatoryRun();
    const src = out.record.source as unknown as Record<string, unknown>;
    expect(src.analysisInputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect('sourceDigest' in src).toBe(false);
    const old = { ...out.record, source: { filename: 'w', sourceDigest: 'f'.repeat(64), basis: 'resident-only', metresPerUnit: 1 } };
    const zip = buildObservatoryPackage(old as unknown as typeof out.record, out.rows, [], { basename: 'o' });
    expect(textOf(zip, 'o/README.md')).toContain(`Analysis input SHA-256  ${'f'.repeat(64)}`);
  });
});

/** Every entry name in a store-only ZIP, read from its central directory. */
function zipEntryNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = view.getUint16(p + 28, true);
    const extra = view.getUint16(p + 30, true);
    const comment = view.getUint16(p + 32, true);
    names.push(new TextDecoder().decode(zip.subarray(p + 46, p + 46 + len)));
    p += 46 + len + extra + comment;
  }
  return names;
}

describe('package builders with an unsafe basename', () => {
  // A layer or file name a user can give: a separator, a backslash, dots and a newline.
  const UNSAFE = 'site/a\\b..\nx';

  function expectSafe(zip: Uint8Array): void {
    const names = zipEntryNames(zip);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(unsafeEntryName(n), n).toBeNull();
      expect(n).not.toMatch(/[\r\n\\]/);
      expect(n.startsWith('site/')).toBe(false);
    }
  }

  it('DEM package and contour deliverable', () => {
    const result = analyseContours(hill(), PARAMS);
    expectSafe(buildDemPackage(result, { basename: UNSAFE, linearUnit: 'metre', digests: D, generationDateIso: '2026-01-01T00:00:00.000Z' }));
    expectSafe(buildContourDeliverableFromResult(result, {
      decision: validatedDecision(DTM_CLAIMS), basename: UNSAFE, isGeographic: false, softwareVersion: 'v', metricVersion: 'm',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'), exportPermit: null, digests: D,
    }));
  });

  it('Observatory, Flow Pulse and Terrain Access packages', () => {
    const out = observatoryRun();
    expectSafe(buildObservatoryPackage(out.record, out.rows, [], { basename: UNSAFE }));
    const flow = flowRun();
    expectSafe(buildFlowPulsePackage(flow, { basename: UNSAFE }));
    const run = terrainAccessRun();
    expectSafe(buildTerrainAccessPackage(run, { basename: UNSAFE }));
  });

  it('Studio PNG package, including its download name', () => {
    const pkg = buildStudioPngPackage({
      basename: UNSAFE, png: new Uint8Array([137, 80, 78, 71]), extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      widthPx: 10, heightPx: 10, worldOrigin: { x: 0, y: 0 }, wkt: 'PROJCS["x"]',
    })!;
    expectSafe(pkg.zip);
    expect(unsafeEntryName(pkg.filename)).toBeNull();
    expect(pkg.filename).toBe('b.._x.zip');
  });

  it('the batch converter names each file safely', () => {
    const c = new PointCloud({ positions: Float32Array.from([0, 0, 0]), origin: [0, 0, 0], sourceFormat: 'las', name: UNSAFE });
    const { file } = convertCloud(c, { format: 'las14' });
    expect(() => buildZip([{ name: file!.filename, bytes: file!.bytes }])).not.toThrow();
  });
});
