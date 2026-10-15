// What these tests would catch:
//
//  - A measurement exported through the ACTIVE scan's origin instead of the
//    scan it was taken on, so adding a second scan moves the first scan's
//    measurements by the distance between the two files.
//  - A file named after the active scan when it holds another scan's work.
//  - A measurement with no recorded scan placed by guessing the active one.
//  - A single-scan export that changes anything beyond the new `source` field.

import { describe, it, expect } from 'vitest';
import {
  exportMeasurementsFile,
  exportMeasurementIntegrityReport,
  type ExportLayerView,
  type MeasurementExportActionDeps,
  geoJsonLonLat,
} from '../src/app/measurementExportActions';
import { UTM13, utm13LonLat } from './helpers/geoJsonLonLat';
import * as serializers from '../src/export/measurementExport';
import * as reportModule from '../src/export/measurementReport';
import type { Measurement } from '../src/render/measure/types';
import type { GeoExportContext } from '../src/app/reportExport';

type V3 = [number, number, number];

const A_ORIGIN: V3 = [500000, 4000000, 99];
const B_ORIGIN: V3 = [500100, 4000000, 50];
// The project frame is anchored at A; B is placed in X/Y only.
const B_OFFSET: V3 = [100, 0, 0];

const view = (offsets: Record<string, V3 | null>): ExportLayerView => ({
  clouds: () => ['cloud_0', 'cloud_1'],
  getCloud: (id) => ({
    name: id === 'cloud_0' ? 'geom-a.las' : 'geom-b.las',
    sourceOrigin: id === 'cloud_0' ? A_ORIGIN : B_ORIGIN,
    metadata: { crs: { name: 'WGS 84 / UTM zone 13N' } },
  }),
  layerProjectOffset: (id) => offsets[id] ?? null,
});
const stableIdFor = (id: string): string => (id === 'cloud_0' ? 'layer-a' : 'layer-b');

function owned(id: string, layerId: string | undefined, pts: V3[], picked = true): Measurement {
  return {
    id, kind: 'distance', name: `Distance ${id}`, points: pts,
    ...(layerId ? { owner: { layerId, frame: 'project' as const }, ...(picked ? { pickLayers: [layerId] } : {}) } : {}),
  };
}

const GEO = (name: string, origin: V3): GeoExportContext => ({ origin, crsName: 'WGS 84 / UTM zone 13N', name, crs: UTM13 });
const lonLatFor = (g: GeoExportContext) => {
  const r = geoJsonLonLat(g, 'z');
  if ('refused' in r) throw new Error(r.refused);
  return r.lonLat;
};

async function run(ms: Measurement[], geo: GeoExportContext, layers: MeasurementExportActionDeps['layers']) {
  const downloads: { filename: string; text: string }[] = [];
  const refusals: string[] = [];
  const deps: MeasurementExportActionDeps = {
    measure: { getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false },
    geo: () => geo,
    upAxis: () => 'z',
    layers,
    refuse: (m) => refusals.push(m),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: (filename, text) => downloads.push({ filename, text }),
    loadMeasurementExport: async () => ({
      ...serializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
    }),
    loadMeasurementReport: async () => { throw new Error('unused'); },
    activeClassificationEpoch: () => 0,
    appVersion: '0.0.0',
    notify: () => undefined,
    now: () => '2026-01-01T00:00:00.000Z',
  };
  await exportMeasurementsFile('geojson', deps);
  await exportMeasurementsFile('csv', deps);
  return { downloads, refusals };
}

describe('two-scan measurement export', () => {
  // A distance on A (project frame == A local), one on B (lifted by B's offset).
  const ms = [
    owned('a1', 'layer-a', [[4, 2, 1], [7, 2, 1]]),
    owned('b1', 'layer-b', [[101, 1, 0], [104, 5, 0]]),
  ];
  const layers = { view: view({ cloud_0: null, cloud_1: B_OFFSET }), stableIdFor };

  it('places each measurement through its own scan, whichever scan is active', async () => {
    const fromA = await run(ms, GEO('geom-a.las', A_ORIGIN), layers);
    const fromB = await run(ms, GEO('geom-b.las', B_ORIGIN), layers);
    expect(fromA.refusals).toEqual([]);
    expect(fromA.downloads.map((d) => d.filename)).toEqual(['geom-a+geom-b-measurements.geojson', 'geom-a+geom-b-measurements.csv', 'geom-a+geom-b-measurements.provenance.txt']);
    expect(fromA.downloads[2].text).toContain('Point basis: not recorded (measurements span 2 scans)');
    const fc = JSON.parse(fromA.downloads[0].text);
    expect(fc.features[0].geometry.coordinates).toEqual([[500004, 4000002, 100], [500007, 4000002, 100]].map(utm13LonLat));
    expect(fc.features[1].geometry.coordinates).toEqual([[500101, 4000001, 50], [500104, 4000005, 50]].map(utm13LonLat));
    expect(fc.features.map((f: { properties: { source: string } }) => f.properties.source)).toEqual(['geom-a', 'geom-b']);
    // Active scan changes nothing about the geometry or the sources.
    const fcB = JSON.parse(fromB.downloads[0].text);
    expect(fcB.features).toEqual(fc.features);
    expect(fromB.downloads[1].text).toBe(fromA.downloads[1].text);
    const [head, r1, r2] = fromA.downloads[1].text.split('\n');
    const col = head.split(',').indexOf('source');
    expect([r1.split(',')[col], r2.split(',')[col]]).toEqual(['geom-a', 'geom-b']);
  });

  it('names the file after the one scan it holds', async () => {
    const out = await run([ms[0]], GEO('geom-b.las', B_ORIGIN), layers);
    expect(out.downloads[0].filename).toBe('geom-a-measurements.geojson');
    expect(JSON.parse(out.downloads[0].text).provenance.source).toBe('geom-a');
  });

  it('refuses rather than guess the scan of an unowned measurement', async () => {
    const out = await run([...ms, owned('x', undefined, [[0, 0, 0], [1, 0, 0]])], GEO('geom-b.las', B_ORIGIN), layers);
    expect(out.downloads).toEqual([]);
    expect(out.refusals[0]).toContain('1 of 3 measurements have no record of the scan');
    expect(out.refusals[0]).toContain('Close every scan but the one');
  });

  it('refuses a set spanning scans with different coordinate systems', async () => {
    const mixed: ExportLayerView = {
      ...layers.view,
      getCloud: (id) => ({ ...layers.view.getCloud(id)!, metadata: { crs: { name: id === 'cloud_0' ? 'UTM 13N' : 'UTM 14N' } } }),
    };
    const out = await run(ms, GEO('geom-a.las', A_ORIGIN), { view: mixed, stableIdFor });
    expect(out.downloads).toEqual([]);
    expect(out.refusals[0]).toContain('different coordinate systems');
  });
});

describe('single-scan measurement export', () => {
  it('is the previous file plus a source field', async () => {
    const one: ExportLayerView = { ...view({}), clouds: () => ['cloud_0'] };
    const m = owned('a1', undefined, [[4, 2, 1], [7, 2, 1]]);
    const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: one, stableIdFor });
    expect(out.downloads.map((d) => d.filename)).toEqual(['geom-a-measurements.geojson', 'geom-a-measurements.csv', 'geom-a-measurements.provenance.txt']);
    const fc = JSON.parse(out.downloads[0].text);
    expect(fc.features[0].geometry.coordinates).toEqual([[500004, 4000002, 100], [500007, 4000002, 100]].map(utm13LonLat));
    // Without the source field the serializers write exactly what they did before.
    const ctx = { toOutput: (p: V3): V3 => [p[0] + A_ORIGIN[0], p[1] + A_ORIGIN[1], p[2] + A_ORIGIN[2]], up: [0, 0, 1] as V3, unitToMetres: 1, verticalUnitToMetres: 1, crsName: 'WGS 84 / UTM zone 13N', unitsVerified: true, lonLat: lonLatFor(GEO('geom-a.las', A_ORIGIN)) };
    const plain = JSON.parse(serializers.measurementsToGeoJSON([m], ctx));
    delete fc.features[0].properties.source;
    expect(fc.features).toEqual(plain.features);
    const csv = out.downloads[1].text.split('\n');
    const prev = serializers.measurementsToCsv([m], ctx).split('\n');
    const col = csv[0].split(',').indexOf('source');
    const drop = (line: string): string => line.split(',').filter((_, i) => i !== col).join(',');
    expect(csv.map(drop)).toEqual(prev.map(drop));
    expect(csv[1].split(',')[col]).toBe('geom-a');
  });
});

describe('a point picked on a scan that is not the active one', () => {
  const A_LOCAL: V3[] = [[4, 2, 1], [7, 2, 1]];
  const B_LOCAL: V3[] = [[1, 1, 0], [4, 5, 0]];
  const A_WORLD = [[500004, 4000002, 100], [500007, 4000002, 100]];
  const B_WORLD = [[500101, 4000001, 50], [500104, 4000005, 50]];
  const add = (p: V3, d: V3 | null): V3 => (d ? [p[0] + d[0], p[1] + d[1], p[2] + d[2]] : p);
  // Offsets into the project frame, for each anchor and placement kind.
  const PLACEMENTS = {
    verified: { anchorA: { a: null, b: [100, 0, -49] }, anchorB: { a: [-100, 0, 49], b: null } },
    'horizontal-only': { anchorA: { a: null, b: [100, 0, 0] }, anchorB: { a: [-100, 0, 0], b: null } },
    unmounted: { anchorA: { a: null, b: null }, anchorB: { a: null, b: null } },
  } as const;

  for (const [kind, anchors] of Object.entries(PLACEMENTS)) {
    it(`B picked while A is active is placed on B (${kind})`, async () => {
      const off = anchors.anchorA as Record<'a' | 'b', V3 | null>;
      const m: Measurement = { ...owned('b1', 'layer-a', B_LOCAL.map((p) => add(p, off.b))), pickLayers: ['layer-b'] };
      const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: off.a, cloud_1: off.b }), stableIdFor });
      const f = JSON.parse(out.downloads[0].text).features[0];
      expect(f.geometry.coordinates).toEqual(B_WORLD.map(utm13LonLat));
      expect(f.properties.source).toBe('geom-b');
      expect(out.downloads[0].filename).toBe('geom-b-measurements.geojson');
    });

    it(`A picked while B is active is placed on A (${kind})`, async () => {
      const off = anchors.anchorB as Record<'a' | 'b', V3 | null>;
      const m: Measurement = { ...owned('a1', 'layer-b', A_LOCAL.map((p) => add(p, off.a))), pickLayers: ['layer-a'] };
      const out = await run([m], GEO('geom-b.las', B_ORIGIN), { view: view({ cloud_0: off.a, cloud_1: off.b }), stableIdFor });
      const f = JSON.parse(out.downloads[0].text).features[0];
      expect(f.geometry.coordinates).toEqual(A_WORLD.map(utm13LonLat));
      expect(f.properties.source).toBe('geom-a');
    });
  }

  it('refuses one measurement whose points sit on scans placed differently', async () => {
    const m: Measurement = { ...owned('x', 'layer-a', [[4, 2, 1], [101, 1, 0]]), name: 'Distance x', pickLayers: ['layer-a', 'layer-b'] };
    const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: null, cloud_1: [100, 0, 0] }), stableIdFor });
    expect(out.downloads).toEqual([]);
    expect(out.refusals[0]).toContain('Distance x has points on scans whose heights are not in one frame');
  });

  it('refuses a Distance on A whose second point was snapped to a vertex picked on B, when B is placed differently', async () => {
    // pickLayers as MeasureController records a snap onto a measurement taken on B.
    const m: Measurement = { ...owned('s', 'layer-a', [[4, 2, 1], [104, 5, 0]]), name: 'Distance s', pickLayers: ['layer-a', 'layer-b'] };
    const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: null, cloud_1: [100, 0, 0] }), stableIdFor });
    expect(out.downloads).toEqual([]);
    expect(out.refusals[0]).toContain('Distance s has points on scans whose heights are not in one frame');
  });

  it('exports a measurement across scans that share one frame', async () => {
    const m: Measurement = { ...owned('x', 'layer-a', [[4, 2, 1], [101, 1, -49]]), pickLayers: ['layer-a', 'layer-b'] };
    const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: null, cloud_1: [100, 0, -49] }), stableIdFor });
    const f = JSON.parse(out.downloads[0].text).features[0];
    expect(f.geometry.coordinates).toEqual([[500004, 4000002, 100], [500101, 4000001, 50]].map(utm13LonLat));
    expect(f.properties.source).toBe('geom-a+geom-b');
  });

  // A restored measurement carries no record of where its points were picked.
  for (const [kind, offB] of [['horizontal-only', [100, 0, 0]], ['unmounted', null]] as [string, V3 | null][]) {
    it(`refuses a measurement with no pick record when the open scans place points differently (${kind})`, async () => {
      const m = owned('r', 'layer-a', B_LOCAL.map((p) => add(p, offB)), false);
      const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: null, cloud_1: offB }), stableIdFor });
      expect(out.downloads).toEqual([]);
      expect(out.refusals[0]).toContain('no record of the scan their points were picked on');
    });
  }

  it('places a measurement with no pick record through its owner when the scans share one frame', async () => {
    const m = owned('r', 'layer-b', B_LOCAL.map((p) => add(p, [100, 0, -49])), false);
    const out = await run([m], GEO('geom-a.las', A_ORIGIN), { view: view({ cloud_0: null, cloud_1: [100, 0, -49] }), stableIdFor });
    expect(JSON.parse(out.downloads[0].text).features[0].geometry.coordinates).toEqual(B_WORLD.map(utm13LonLat));
  });
});

describe('a measurement whose scan was closed', () => {
  // Measured on A; A then closed and B opened. B is the only open layer.
  const onlyB: ExportLayerView = {
    clouds: () => ['cloud_1'],
    getCloud: () => ({ name: 'geom-b.las', sourceOrigin: [500, 600, 0], metadata: { crs: { name: 'WGS 84 / UTM zone 13N' } } }),
    layerProjectOffset: () => null,
  };
  const bOnly = { view: onlyB, stableIdFor: () => 'layer-b' };

  it.each([
    ['picked and owned', true],
    ['owned only (restored)', false],
  ])('is refused, with nothing downloaded and nothing of B written (%s)', async (_k, picked) => {
    const m = owned('a1', 'layer-a', [[0, 0, 0], [1, 0, 0]], picked);
    const out = await run([m], GEO('geom-b.las', [500, 600, 0]), bOnly);
    expect(out.downloads).toEqual([]);
    expect(out.refusals).toHaveLength(2);
    expect(out.refusals[0]).toBe('Not exported: 1 measurement was taken on a scan that is no longer open. Reopen it or delete them, then export again.');
    expect(out.refusals.join(' ')).not.toMatch(/geom-b|500|600/);
  });

  it('refuses the signed integrity report too, before anything is loaded or written', async () => {
    const m = owned('a1', 'layer-a', [[0, 0, 0], [1, 0, 0]]);
    const downloads: string[] = [];
    const refusals: string[] = [];
    let loaded = false;
    await exportMeasurementIntegrityReport({
      measure: { getMeasurements: () => [m], worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false },
      geo: () => GEO('geom-b.las', [500, 600, 0]),
      layers: bOnly,
      refuse: (t) => refusals.push(t),
      baseName: (n) => n.replace(/\.[^.]+$/, ''),
      downloadText: (f) => downloads.push(f),
      loadMeasurementExport: async () => { throw new Error('unused'); },
      loadMeasurementReport: async () => { loaded = true; throw new Error('must not load'); },
      activeClassificationEpoch: () => 0,
      appVersion: '0.0.0',
      notify: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(loaded).toBe(false);
    expect(downloads).toEqual([]);
    expect(refusals).toEqual(['Not exported: 1 measurement was taken on a scan that is no longer open. Reopen it or delete them, then export again.']);
  });

  it('still exports a restored measurement owned by the one open scan', async () => {
    const m = owned('b1', 'layer-b', [[0, 0, 0], [1, 0, 0]], false);
    const out = await run([m], GEO('geom-b.las', [500_500, 4_000_600, 0]), bOnly);
    expect(out.refusals).toEqual([]);
    expect(JSON.parse(out.downloads[0].text).features[0].geometry.coordinates[0]).toEqual(utm13LonLat([500_500, 4_000_600, 0]));
  });
});

describe('a change while the serializer chunk loads', () => {
  it('builds the file from the values read before the await', async () => {
    const A: Measurement = owned('a1', undefined, [[0, 0, 0], [10, 0, 0]]);
    const B: Measurement = owned('b1', undefined, [[0, 0, 0], [99, 0, 0]]);
    const live = { ms: [A], unit: 1, name: 'geom-a.las', origin: A_ORIGIN as V3 };
    const one: ExportLayerView = {
      clouds: () => ['cloud_0'],
      getCloud: () => ({ name: live.name, sourceOrigin: live.origin, metadata: null }),
      layerProjectOffset: () => null,
    };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const downloads: { filename: string; text: string }[] = [];
    const deps: MeasurementExportActionDeps = {
      measure: {
        getMeasurements: () => live.ms,
        get worldUp() { return [0, 0, 1] as V3; },
        get unitToMetres() { return live.unit; },
        get verticalUnitToMetres() { return live.unit; },
        crsKnown: true,
        geographicCrs: false,
      },
      geo: () => ({ origin: live.origin, crsName: 'WGS 84 / UTM zone 13N', name: live.name }),
      layers: { view: one, stableIdFor: () => 'layer-x' },
      refuse: () => undefined,
      baseName: (n) => n.replace(/\.[^.]+$/, ''),
      downloadText: (filename, text) => downloads.push({ filename, text }),
      loadMeasurementExport: async () => {
        await gate;
        return { ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never) };
      },
      loadMeasurementReport: async () => { throw new Error('unused'); },
      activeClassificationEpoch: () => 0,
      appVersion: '0.0.0',
      notify: () => undefined,
      now: () => '2026-01-01T00:00:00.000Z',
    };
    const pending = exportMeasurementsFile('csv', deps);
    // Swap the scan and the unit scale mid-export, and mutate the original in place.
    live.ms = [B];
    live.unit = 0.3048;
    live.name = 'geom-b.las';
    live.origin = [1, 2, 3];
    (A.points as V3[])[1] = [77, 0, 0];
    release();
    await pending;
    expect(downloads).toHaveLength(2);
    expect(downloads[0].filename).toBe('geom-a-measurements.csv');
    expect(downloads[1].filename).toBe('geom-a-measurements.provenance.txt');
    expect(downloads[1].text).toContain('Source file: geom-a.las');
    expect(downloads[1].text).not.toMatch(/geom-b/);
    const [head, row] = downloads[0].text.split('\n');
    const cols = head.split(',');
    const cell = (k: string): string => row.split(',')[cols.indexOf(k)]!;
    expect(cell('source')).toBe('geom-a');
    expect(Number(cell(cols.find((c) => /length|value|distance/i.test(c) && c.endsWith('_m'))!))).toBeCloseTo(10, 6);
    expect(downloads[0].text).not.toMatch(/geom-b|0\.3048|\b99\b|\b77\b/);
  });
});

describe('a streamed scan with no static layer open', () => {
  // A COPC replaced the scan the first distance was taken on; the second was
  // placed on the stream itself. No static layer is open.
  const STREAM_ORIGIN: V3 = [500_000, 4_000_000, 0];
  const noLayers: ExportLayerView = { clouds: () => [], getCloud: () => undefined, layerProjectOffset: () => null };
  const retired = owned('old', 'retired-scan', [[0, 0, 0], [5, 0, 0]], false);
  const current = owned('new', undefined, [[1, 1, 0], [4, 1, 0]]);

  async function runStream(ms: Measurement[]) {
    const downloads: { filename: string; text: string }[] = [];
    const refusals: string[] = [];
    const notes: string[] = [];
    const deps: MeasurementExportActionDeps = {
      measure: { getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false },
      geo: () => GEO('new.copc.laz', STREAM_ORIGIN),
      upAxis: () => 'z',
      layers: { view: noLayers, stableIdFor: () => null },
      refuse: (m) => refusals.push(m),
      notify: (m) => notes.push(m),
      baseName: (n) => n.replace(/\.[^.]+$/, '').replace(/\.copc$/, ''),
      downloadText: (filename, text) => downloads.push({ filename, text }),
      loadMeasurementExport: async () => ({
        ...serializers,
        resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
      }),
      loadMeasurementReport: async () => ({
        ...reportModule,
        resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
      }),
      activeClassificationEpoch: () => 0,
      appVersion: '0.0.0',
      now: () => '2026-01-01T00:00:00.000Z',
    };
    await exportMeasurementsFile('geojson', deps);
    await exportMeasurementsFile('csv', deps);
    await exportMeasurementIntegrityReport(deps);
    return { downloads, refusals, notes };
  }

  it('writes no file under the stream for work left from the replaced scan', async () => {
    const out = await runStream([retired]);
    expect(out.downloads).toEqual([]);
    expect(out.refusals).toEqual(Array(3).fill('Not exported: 1 measurement was taken on a scan that is no longer open. Reopen it or delete them, then export again.'));
  });

  it('exports the work taken on the stream itself and withholds the rest, saying why; the signed report refuses', async () => {
    const out = await runStream([retired, current]);
    // A signed integrity report must account for every record: it refuses
    // rather than drop the one it cannot place.
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toMatch(/integrity report must account for every measurement/);
    expect(out.downloads.some((d) => /findings|integrity|\.json$/.test(d.filename) && d.text.includes('"findings"'))).toBe(false);
    const [geojson, csv] = out.downloads;
    const fc = JSON.parse(geojson!.text);
    expect(fc.features.map((f: { properties: { id: string } }) => f.properties.id)).toEqual(['new']);
    expect(csv!.text.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
    expect(csv!.text).not.toContain('old');
    expect(out.notes.filter((n) => n.includes('1 measurement withheld: taken on a scan that is no longer open'))).toHaveLength(2);
  });

  it('leaves the bytes of a stream-only export unchanged', async () => {
    const withRetired = await runStream([retired, current]);
    const alone = await runStream([current]);
    // The GeoJSON and CSV files are identical; only the alone run also writes the report.
    expect(withRetired.downloads.map((d) => d.text)).toEqual(alone.downloads.slice(0, withRetired.downloads.length).map((d) => d.text));
    expect(alone.downloads.length).toBe(withRetired.downloads.length + 1);
    expect(alone.notes.some((n) => n.includes('withheld'))).toBe(false);
  });
});
