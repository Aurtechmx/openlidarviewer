/**
 * A measurement exports through the frame of the scan it was taken on.
 *
 * The exporter placed each measurement through its owning scan's ORIGIN but
 * labelled and converted it with the ACTIVE scan's CRS, unit scales, up-axis and
 * digests, so a UTM 12N measurement exported while a UTM 13N scan was active
 * came out at longitude -105 under scan A's name, with no refusal. These tests
 * pin that the active scan never changes another scan's output, that
 * measurements on scans with different frames are refused by name, and that
 * scans sharing a frame still export together.
 */

import { describe, it, expect } from 'vitest';
import { exportMeasurementsFile, exportMeasurementIntegrityReport, collectMeasurementFindings, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import * as reportSerializers from '../src/export/measurementReport';
import { geoContextForCloud } from '../src/app/reportExport';
import { CrsService } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { Measurement } from '../src/render/measure/types';
import type { PointCloud } from '../src/model/PointCloud';

const utm = (zone: number, epsg: number): CrsInfo => ({ source: 'wkt', name: `WGS 84 / UTM zone ${zone}N`, epsg, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false });
const UTM12 = utm(12, 32612);
const UTM13 = utm(13, 32613);
// NAD83 / Colorado North (ftUS): a different unit scale on the same grid shape.
const FOOT: CrsInfo = { source: 'wkt', name: 'NAD83 / Colorado North (ftUS)', epsg: 2231, linearUnit: 'us-survey-foot', linearUnitToMetres: 1200 / 3937, isGeographic: false };

interface Scan { id: string; stable: string; file: string; crs: CrsInfo }

function world(scans: readonly Scan[], active: string) {
  const svc = new CrsService({ get: () => undefined, set: () => undefined, clear: () => undefined });
  const byId = new Map(scans.map((s) => [s.id, s]));
  const clouds = new Map(scans.map((s) => [s.id, {
    name: s.file, sourceOrigin: [500_000, 4_000_000, 0] as [number, number, number], pointCount: 10, metadata: { crs: s.crs }, sourceFormat: 'las',
  } as unknown as PointCloud]));
  const a = byId.get(active)!;
  svc.resolveForScan({ name: a.file, detected: a.crs, source: 'las-vlr' });
  const files: Array<{ name: string; text: string }> = [];
  const refusals: string[] = [];
  const reportCalls: unknown[][] = [];
  const dist = (id: string, s: Scan): Measurement => ({ id, name: `Distance ${id}`, kind: 'distance', points: [[0, 0, 0], [10, 0, 0]], pickLayers: [s.stable], owner: { layerId: s.stable, frame: 'project' } });
  const make = (ms: Measurement[]): MeasurementExportActionDeps => ({
    // The measure view mirrors the ACTIVE scan, as the live controller does.
    measure: {
      getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: svc.context().linearUnitToMetres, verticalUnitToMetres: svc.context().linearUnitToMetres,
      crsKnown: svc.context().linearUnitKnown, geographicCrs: svc.context().isGeographic,
    },
    geo: () => geoContextForCloud(clouds.get(active)!, svc.current()),
    upAxis: () => 'z',
    layers: {
      stableIdFor: (id) => byId.get(id)?.stable ?? null,
      view: { clouds: () => scans.map((s) => s.id), getCloud: (id) => clouds.get(id) as never, layerProjectOffset: () => null },
    },
    frameSource: {
      activeId: () => active,
      activeGeo: () => geoContextForCloud(clouds.get(active)!, svc.current()),
      activeUpAxis: () => 'z',
      cloud: (id) => clouds.get(id),
      classificationEpoch: () => 0,
      crs: svc,
    },
    refuse: (m) => refusals.push(m),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: (name, text) => files.push({ name, text }),
    loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null } as never) }),
    loadMeasurementReport: async () => ({
      ...reportSerializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null } as never),
      integrityReportFile: (...args: unknown[]) => { reportCalls.push(args); return { filename: 'r.json', text: '{}' }; },
    } as never),
    activeClassificationEpoch: () => 0,
    appVersion: 'test',
    notify: () => undefined,
    now: () => '2026-10-11T00:00:00Z',
  });
  return { make, dist, files, refusals, reportCalls };
}

const A: Scan = { id: 'a', stable: 'layer-a', file: 'a.las', crs: UTM12 };
const B: Scan = { id: 'b', stable: 'layer-b', file: 'b.las', crs: UTM13 };

describe('measurement export uses the owning scan frame', () => {
  it('exports a UTM 12N measurement at longitude -111 while the UTM 13N scan is active', async () => {
    const w = world([A, B], 'b');
    await exportMeasurementsFile('geojson', w.make([w.dist('m', A)]));
    expect(w.refusals).toEqual([]);
    const f = JSON.parse(w.files[0]!.text);
    expect(f.features[0].geometry.coordinates[0][0]).toBeCloseTo(-111, 5);
    expect(w.files[0]!.name).toBe('a-measurements.geojson');
  });

  it.each(['geojson', 'csv'] as const)('%s output for a measurement on A is identical with A or B active', async (format) => {
    const onA = world([A, B], 'a');
    await exportMeasurementsFile(format, onA.make([onA.dist('m', A)]));
    const onB = world([A, B], 'b');
    await exportMeasurementsFile(format, onB.make([onB.dist('m', A)]));
    expect(onB.refusals).toEqual([]);
    expect(onB.files).toEqual(onA.files);
  });

  it("does not apply another scan's unit scale to a measurement", async () => {
    const onA = world([A, FOOT_SCAN], 'a');
    await exportMeasurementsFile('csv', onA.make([onA.dist('m', A)]));
    const onFoot = world([A, FOOT_SCAN], 'foot');
    await exportMeasurementsFile('csv', onFoot.make([onFoot.dist('m', A)]));
    expect(onFoot.files).toEqual(onA.files);
    // A 10-unit metre-CRS distance is 10 m, not 10 ftUS.
    expect(onFoot.files[0]!.text).toMatch(/(^|,)10(\.0+)?(,|$)/m);
  });

  it('refuses measurements from scans with different frames, naming both', async () => {
    const w = world([A, B], 'a');
    await exportMeasurementsFile('geojson', w.make([w.dist('m1', A), w.dist('m2', B)]));
    expect(w.files).toEqual([]);
    expect(w.refusals).toEqual([
      'Not exported: measurements on a.las (EPSG:32612) and b.las (EPSG:32613) use different coordinate frames; export one scan\'s measurements at a time.',
    ]);
  });

  it('refuses CSV the same way', async () => {
    const w = world([A, B], 'b');
    await exportMeasurementsFile('csv', w.make([w.dist('m1', A), w.dist('m2', B)]));
    expect(w.files).toEqual([]);
    expect(w.refusals[0]).toContain('different coordinate frames');
  });

  it('refuses scans that share a CRS but differ in unit scale, and tells them apart', async () => {
    const feetTwin: Scan = { id: 'c', stable: 'layer-c', file: 'c.las', crs: { ...UTM12, linearUnit: 'foot', linearUnitToMetres: 0.3048 } };
    const w = world([A, feetTwin], 'a');
    await exportMeasurementsFile('csv', w.make([w.dist('m1', A), w.dist('m2', feetTwin)]));
    expect(w.files).toEqual([]);
    expect(w.refusals[0]).toMatch(/a\.las \(EPSG:32612, 1 m\/unit.*c\.las \(EPSG:32612, 0\.3048 m\/unit/);
  });

  it('still exports measurements from several scans that share one frame', async () => {
    const A2: Scan = { id: 'a2', stable: 'layer-a2', file: 'a2.las', crs: UTM12 };
    const w = world([A, A2, B], 'b');
    await exportMeasurementsFile('geojson', w.make([w.dist('m1', A), w.dist('m2', A2)]));
    expect(w.refusals).toEqual([]);
    expect(w.files).toHaveLength(1);
    const f = JSON.parse(w.files[0]!.text);
    expect(f.features).toHaveLength(2);
    expect(f.features[0].geometry.coordinates[0][0]).toBeCloseTo(-111, 5);
  });

  it("states a non-active owner's own point basis in the CSV sidecar", async () => {
    const w = world([A, B], 'b');
    await exportMeasurementsFile('csv', w.make([w.dist('m', A)]));
    expect(w.files[1]!.text).toContain('Source file: a.las');
    expect(w.files[1]!.text).toContain('full file (10 points)');
  });

  it('the integrity report names the owning scan and its CRS whichever scan is active', async () => {
    const onA = world([A, B], 'a');
    await exportMeasurementIntegrityReport(onA.make([onA.dist('m', A)]));
    const onB = world([A, B], 'b');
    await exportMeasurementIntegrityReport(onB.make([onB.dist('m', A)]));
    expect(onB.reportCalls[0]![4]).toBe('a');
    expect(onB.reportCalls[0]![5]).toBe('WGS 84 / UTM zone 12N');
    expect(onB.reportCalls[0]).toEqual(onA.reportCalls[0]);
  });

  it('the integrity report and findings refuse mixed frames', async () => {
    const w = world([A, B], 'a');
    const d = w.make([w.dist('m1', A), w.dist('m2', B)]);
    await exportMeasurementIntegrityReport(d);
    expect(w.reportCalls).toEqual([]);
    expect(await collectMeasurementFindings(d)).toEqual([]);
    expect(w.refusals).toHaveLength(2);
    expect(w.refusals[0]).toContain('different coordinate frames');
  });

  it('a measurement with no recorded owner keeps exporting through the active frame', async () => {
    const w = world([A], 'a');
    const m: Measurement = { id: 'legacy', name: 'Legacy', kind: 'distance', points: [[0, 0, 0], [10, 0, 0]] };
    await exportMeasurementsFile('csv', w.make([m]));
    expect(w.refusals).toEqual([]);
    expect(w.files.length).toBeGreaterThan(0);
  });
});

const FOOT_SCAN: Scan = { id: 'foot', stable: 'layer-foot', file: 'foot.las', crs: FOOT };
