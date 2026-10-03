// What these tests would catch:
//
//  - Two tiles with one file name, one point count and one set of spans, 1 km
//    apart, bound to one layer id, so a measurement on the second tile exports
//    at the first tile's origin.
//  - A layer id handed to a second open layer while the first still holds it.
//  - Closing one of two such tiles leaving its measurements exportable through
//    the other.
//  - A measurement whose owner id matches two open layers placed through the
//    first match instead of refused.

import { describe, it, expect } from 'vitest';
import { createLayerIdentityService } from '../src/app/layerIdentityService';
import { LayerIdentityRegistry, fingerprintKey, type LayerFingerprint } from '../src/model/layerIdentity';
import { resolveOwnerLayer } from '../src/model/workOwnership';
import {
  exportMeasurementsFile,
  exportMeasurementIntegrityReport,
  type ExportLayerView,
  type MeasurementExportActionDeps,
} from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import type { Measurement } from '../src/render/measure/types';

type V3 = [number, number, number];
const A_ORIGIN: V3 = [500000, 4000000, 0];
const B_ORIGIN: V3 = [501000, 4000000, 0];
const TILE: LayerFingerprint = { fileName: 'tile.las', sourcePoints: 10_000, width: 100, depth: 100, height: 10 };

function counter(): () => string {
  let n = 0;
  return () => `layer_${n++}`;
}

function view(open: string[], offsets: Record<string, V3 | null> = {}): ExportLayerView {
  return {
    clouds: () => open,
    getCloud: (id) => ({ name: 'tile.las', sourceOrigin: id === 'cloud_0' ? A_ORIGIN : B_ORIGIN, metadata: null }),
    layerProjectOffset: (id) => offsets[id] ?? null,
  };
}

function picked(id: string, layerId: string, pts: V3[]): Measurement {
  return { id, kind: 'distance', name: `Distance ${id}`, points: pts, owner: { layerId, frame: 'project' }, pickLayers: [layerId] };
}

async function run(ms: Measurement[], layers: MeasurementExportActionDeps['layers']) {
  const downloads: { filename: string; text: string }[] = [];
  const refusals: string[] = [];
  const reports: string[] = [];
  const deps: MeasurementExportActionDeps = {
    measure: { getMeasurements: () => ms, worldUp: [0, 0, 1], unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: false, geographicCrs: false },
    geo: () => ({ origin: A_ORIGIN, crsName: undefined, name: 'tile.las' }),
    layers,
    refuse: (m) => refusals.push(m),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: (filename, text) => downloads.push({ filename, text }),
    loadMeasurementExport: async () => ({
      ...serializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
    }),
    loadMeasurementReport: async () => {
      reports.push('built');
      throw new Error('report reached');
    },
    activeClassificationEpoch: () => 0,
    appVersion: '0.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
  };
  await exportMeasurementsFile('geojson', deps);
  await exportMeasurementIntegrityReport(deps).catch(() => undefined);
  return { downloads, refusals, reports };
}

function bindTiles() {
  const svc = createLayerIdentityService({ generateId: counter() });
  const a = svc.bindOnLoad('cloud_0', { ...TILE, origin: A_ORIGIN }, 'tile.las', [])!;
  const b = svc.bindOnLoad('cloud_1', { ...TILE, origin: B_ORIGIN }, 'tile.las', ['cloud_0'])!;
  return { svc, a, b };
}

describe('layer identity for same-name, same-size scans', () => {
  it('gives two tiles 1 km apart distinct ids', () => {
    const { a, b } = bindTiles();
    expect(a.layerId).not.toBe(b.layerId);
    expect(fingerprintKey({ ...TILE, origin: A_ORIGIN })).not.toBe(fingerprintKey({ ...TILE, origin: B_ORIGIN }));
  });

  it('keys on the content digest when it is known', () => {
    expect(fingerprintKey({ ...TILE, sha256: 'aa' })).not.toBe(fingerprintKey({ ...TILE, sha256: 'bb' }));
  });

  it('never hands out an id a live record holds', () => {
    const reg = new LayerIdentityRegistry({ generateId: counter() });
    const first = reg.resolve(TILE, 'tile.las');
    const second = reg.resolve({ ...TILE }, 'tile.las');
    expect(second.layerId).not.toBe(first.layerId);
    reg.remove(first.layerId);
    expect(reg.resolve({ ...TILE }, 'tile.las').layerId).toBe(first.layerId);
  });

  it('gives a reopened tile its id back after it closed', () => {
    const { svc, a } = bindTiles();
    const again = svc.bindOnLoad('cloud_2', { ...TILE, origin: A_ORIGIN }, 'tile.las', ['cloud_1']);
    expect(again!.layerId).toBe(a.layerId);
  });

  it('matches a stored fingerprint without a position only when one layer fits', () => {
    const both = [
      { layerId: 'a', facts: { ...TILE, origin: A_ORIGIN } },
      { layerId: 'b', facts: { ...TILE, origin: B_ORIGIN } },
    ];
    expect(resolveOwnerLayer(both, TILE)).toEqual({ kind: 'unresolved', reason: 'ambiguous' });
    expect(resolveOwnerLayer([both[0]!], TILE)).toEqual({ kind: 'resolved', layerId: 'a' });
    expect(resolveOwnerLayer(both, { ...TILE, origin: B_ORIGIN })).toEqual({ kind: 'resolved', layerId: 'b' });
  });
});

describe('measurement export with same-name, same-size scans', () => {
  it('exports an unmounted B measurement at B\'s origin', async () => {
    const { svc, b } = bindTiles();
    const out = await run([picked('b1', b.layerId, [[1, 1, 1], [2, 1, 1]])], { view: view(['cloud_0', 'cloud_1']), stableIdFor: svc.stableIdFor });
    expect(out.refusals).toEqual([]);
    const fc = JSON.parse(out.downloads[0]!.text);
    expect(fc.features[0].geometry.coordinates[0]).toEqual([501001, 4000001, 1]);
  });

  it('refuses A\'s measurements once A is closed and B is open', async () => {
    const { svc, a } = bindTiles();
    const out = await run([picked('a1', a.layerId, [[1, 1, 1], [2, 1, 1]])], { view: view(['cloud_1']), stableIdFor: svc.stableIdFor });
    expect(out.downloads).toEqual([]);
    expect(out.reports).toEqual([]);
    expect(out.refusals).toHaveLength(2);
    expect(out.refusals[0]).toContain('no longer open');
  });

  it('refuses a measurement whose owner id two open layers carry', async () => {
    const out = await run([picked('m', 'dup', [[1, 1, 1], [2, 1, 1]])], { view: view(['cloud_0', 'cloud_1']), stableIdFor: () => 'dup' });
    expect(out.downloads).toEqual([]);
    expect(out.reports).toEqual([]);
    expect(out.refusals[0]).toContain('more than one open scan');
  });

  it('leaves a mounted pair as it was', async () => {
    const { svc, a, b } = bindTiles();
    const layers = { view: view(['cloud_0', 'cloud_1'], { cloud_0: [0, 0, 0], cloud_1: [1000, 0, 0] }), stableIdFor: svc.stableIdFor };
    const out = await run([picked('a1', a.layerId, [[1, 1, 1], [2, 1, 1]]), picked('b1', b.layerId, [[1001, 1, 1], [1002, 1, 1]])], layers);
    expect(out.refusals).toEqual([]);
    const fc = JSON.parse(out.downloads[0]!.text);
    expect(fc.features[0].geometry.coordinates[0]).toEqual([500001, 4000001, 1]);
    expect(fc.features[1].geometry.coordinates[0]).toEqual([501001, 4000001, 1]);
  });
});
