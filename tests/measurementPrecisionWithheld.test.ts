/**
 * A separation smaller than the step a scan's positions are held at is
 * withheld, never reported as zero.
 *
 * A LAS whose integer records keep a 5 mm separation 200 km from the local
 * origin loads into Float32 positions where the two points coincide. The
 * precision permit already refuses that scan (about 16 mm steps); the Measure
 * panel and the CSV used to print 0 cm and 0 m all the same. At 1 km the same
 * separation is held and must still be reported.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { writeLas } from '../src/convert/writeLas';
import { loadLas } from '../src/io/loadLas';
import { CrsService, datasetIdentity } from '../src/geo/CrsService';
import { bindMeasureUnitFrames } from '../src/app/measureLayerUnits';
import { geoContextForCloud } from '../src/app/reportExport';
import { exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import { scanPrecisionPermit } from '../src/app/scanPrecision';
import { installFakeDom } from './support/measurePanelDom';
import type { Measurement, Vec3 } from '../src/render/measure/types';

beforeAll(() => installFakeDom({ ns: true }));

/** Three points on one line: the second at `reach` metres east, the third 5 mm beyond it. */
function lasBytes(reach: number): Uint8Array {
  return writeLas(
    {
      count: 3,
      x: Float64Array.from([500000, 500000 + reach, 500000 + reach + 0.005]),
      y: Float64Array.from([4000000, 4000000, 4000000]),
      z: Float64Array.from([100, 100, 100]),
    },
    { epsg: 32613 },
  );
}

/** The separation the source file holds, read from its integer records and scale, not through the loader. */
function sourceSeparation(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = dv.getUint32(96, true);
  const record = dv.getUint16(105, true);
  const scaleX = dv.getFloat64(131, true);
  return (dv.getInt32(start + 2 * record, true) - dv.getInt32(start + record, true)) * scaleX;
}

async function measureAndExport(reach: number) {
  const bytes = lasBytes(reach);
  const cloud = await loadLas(bytes.buffer as ArrayBuffer, 'las', 'precise-wide.las');
  const store = new Map<string, unknown>();
  const svc = new CrsService({
    get: (k) => store.get(k) as never,
    set: (k, v) => store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => { store.delete(k); },
  });
  svc.resolveForScan({ name: cloud.name, detected: cloud.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {}, getPickRay: () => null, getPointAt: () => null } as never);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  const units = bindMeasureUnitFrames(measure, {
    activeId: () => 'a', clouds: () => ['a'], cloud: () => cloud, stableIdFor: () => 'layer-a', crs: svc,
    projectOffset: () => null,
  });
  units.onCrsChange();
  const points = [Array.from(cloud.positions.slice(3, 6)), Array.from(cloud.positions.slice(6, 9))] as [Vec3, Vec3];
  const m = {
    id: 'length', kind: 'distance', name: 'Source separation 5 mm', closed: false, points,
    pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' },
  } as Measurement;
  measure.loadMeasurements([m]);
  const files: { name: string; text: string }[] = [];
  const refusals: string[] = [];
  const deps = {
    measure, geo: () => geoContextForCloud(cloud, svc.current()), upAxis: () => 'z',
    layers: { stableIdFor: () => 'layer-a', view: { clouds: () => ['a'], getCloud: () => cloud, layerProjectOffset: () => null } },
    frameSource: {
      activeId: () => 'a', activeGeo: () => geoContextForCloud(cloud, svc.current()), activeUpAxis: () => 'z',
      cloud: () => cloud, classificationEpoch: () => 0, crs: svc,
    },
    refuse: (s: string) => refusals.push(s), notify: () => {}, baseName: (s: string) => s,
    downloadText: (name: string, text: string) => files.push({ name, text }),
    loadMeasurementExport: async () => ({
      ...serializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'test', crsOrigin: null }),
    }),
    loadMeasurementReport: async () => ({}), activeClassificationEpoch: () => 0, appVersion: 'test',
    now: () => '2026-10-20T00:00:00Z',
  } as unknown as MeasurementExportActionDeps;
  await exportMeasurementsFile('csv', deps);
  const csv = files.find((f) => f.name.endsWith('.csv'))?.text ?? '';
  const [head, row] = csv.split('\n');
  const cells = row?.split(',') ?? [];
  const length = cells[head.split(',').indexOf('length_m')];
  return {
    bytes, cloud, svc, csv, row: row ?? '', length, refusals,
    loaded: points[1][0] - points[0][0],
    live: measure.getSummaries()[0]?.value ?? '',
  };
}

describe('a separation below the position step', () => {
  it('the source keeps 5 mm whatever the reach', () => {
    expect(sourceSeparation(lasBytes(1000))).toBeCloseTo(0.005, 9);
    expect(sourceSeparation(lasBytes(200_000))).toBeCloseTo(0.005, 9);
  });

  it('at 1 km the 5 mm separation is held and reported', async () => {
    const r = await measureAndExport(1000);
    expect(Number(r.length)).toBeCloseTo(0.005, 3);
    expect(r.live).not.toMatch(/not resolved/);
    expect(r.csv).not.toMatch(/not resolved/);
  });

  it('at 200 km it is withheld with the reason in the panel and the CSV, not written as 0', async () => {
    const r = await measureAndExport(200_000);
    // The loaded positions really do coincide, and the permit refuses the scan.
    expect(r.loaded).toBe(0);
    expect(scanPrecisionPermit({ cloud: r.cloud, crs: r.svc.current() })?.ok).toBe(false);
    expect(r.length).toBe('');
    expect(r.row).toMatch(/not resolved/);
    expect(r.row).toMatch(/Load a smaller tile/);
    expect(r.live).toMatch(/^not resolved: this scan holds positions about 15\.63 mm apart/);
    expect(r.live).not.toMatch(/0\.0 cm|0 cm/);
  });
});
