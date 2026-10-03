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
  type ExportLayerView,
  type MeasurementExportActionDeps,
} from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
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

const GEO = (name: string, origin: V3): GeoExportContext => ({ origin, crsName: 'WGS 84 / UTM zone 13N', name });

async function run(ms: Measurement[], geo: GeoExportContext, layers: MeasurementExportActionDeps['layers']) {
  const downloads: { filename: string; text: string }[] = [];
  const refusals: string[] = [];
  const deps: MeasurementExportActionDeps = {
    measure: { getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: true, geographicCrs: false },
    geo: () => geo,
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
    expect(fromA.downloads.map((d) => d.filename)).toEqual(['geom-a+geom-b-measurements.geojson', 'geom-a+geom-b-measurements.csv']);
    const fc = JSON.parse(fromA.downloads[0].text);
    expect(fc.features[0].geometry.coordinates).toEqual([[500004, 4000002, 100], [500007, 4000002, 100]]);
    expect(fc.features[1].geometry.coordinates).toEqual([[500101, 4000001, 50], [500104, 4000005, 50]]);
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
    expect(out.downloads.map((d) => d.filename)).toEqual(['geom-a-measurements.geojson', 'geom-a-measurements.csv']);
    const fc = JSON.parse(out.downloads[0].text);
    expect(fc.features[0].geometry.coordinates).toEqual([[500004, 4000002, 100], [500007, 4000002, 100]]);
    // Without the source field the serializers write exactly what they did before.
    const ctx = { toOutput: (p: V3): V3 => [p[0] + A_ORIGIN[0], p[1] + A_ORIGIN[1], p[2] + A_ORIGIN[2]], up: [0, 0, 1] as V3, unitToMetres: 1, verticalUnitToMetres: 1, crsName: 'WGS 84 / UTM zone 13N', unitsVerified: true };
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
      expect(f.geometry.coordinates).toEqual(B_WORLD);
      expect(f.properties.source).toBe('geom-b');
      expect(out.downloads[0].filename).toBe('geom-b-measurements.geojson');
    });

    it(`A picked while B is active is placed on A (${kind})`, async () => {
      const off = anchors.anchorB as Record<'a' | 'b', V3 | null>;
      const m: Measurement = { ...owned('a1', 'layer-b', A_LOCAL.map((p) => add(p, off.a))), pickLayers: ['layer-a'] };
      const out = await run([m], GEO('geom-b.las', B_ORIGIN), { view: view({ cloud_0: off.a, cloud_1: off.b }), stableIdFor });
      const f = JSON.parse(out.downloads[0].text).features[0];
      expect(f.geometry.coordinates).toEqual(A_WORLD);
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
    expect(f.geometry.coordinates).toEqual([[500004, 4000002, 100], [500101, 4000001, 50]]);
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
    expect(JSON.parse(out.downloads[0].text).features[0].geometry.coordinates).toEqual(B_WORLD);
  });
});
