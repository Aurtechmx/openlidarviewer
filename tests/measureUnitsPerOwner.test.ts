/**
 * Each measurement reads out in the units of the scan it was taken on, not the
 * active scan's. Render space keeps each layer's source units, so a 100-unit
 * distance on a metre scan is 100 m and on a US-survey-foot scan is 30.48 m,
 * whichever scan is active. Work that spans layers with different units has no
 * single factor and reads as unverified; work that names no layer keeps the
 * active scan's factors.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import { UNIT_UNVERIFIED } from '../src/render/measure/format';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import type { MeasureUnitFrame } from '../src/render/measure/types';
import { bindMeasureUnitFrames, chainUnitFrame } from '../src/app/measureLayerUnits';
import { exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import { geoContextForCloud } from '../src/app/reportExport';
import * as serializers from '../src/export/measurementExport';
import { CrsService } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { PointCloud } from '../src/model/PointCloud';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const US_SURVEY_FOOT = 1200 / 3937;

const frame = (unitToMetres: number, over: Partial<MeasureUnitFrame> = {}): MeasureUnitFrame => ({
  unitToMetres,
  verticalUnitToMetres: unitToMetres,
  verticalUnitKnown: true,
  verticalUnitInvalid: false,
  crsKnown: true,
  geographic: false,
  verticalRefused: false,
  projected: true,
  ...over,
});

const FRAMES: Record<string, MeasureUnitFrame> = {
  'layer-m': frame(1),
  'layer-ft': frame(US_SURVEY_FOOT),
};

function dist(id: string, layers: string[] | null): Measurement {
  return {
    id, kind: 'distance', name: id, closed: false,
    points: [[0, 0, 0], [100, 0, 0]],
    ...(layers ? { pickLayers: layers, owner: { layerId: layers[0]!, frame: 'project' } } : {}),
  } as Measurement;
}

async function controller(): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  measure.setUnitResolver((layerId) => FRAMES[layerId] ?? null);
  return measure;
}

const labelsOf = (measure: MC): string[] =>
  (measure as unknown as { _buildModel(): { labels: { text: string; primary: boolean }[] } })
    ._buildModel().labels.filter((l) => l.primary).map((l) => l.text);

describe('measurement readouts use the owning scan units', () => {
  it('switching the active scan factor does not rescale owned measurements', async () => {
    const measure = await controller();
    measure.loadMeasurements([dist('a', ['layer-m']), dist('b', ['layer-ft'])]);
    const before = measure.getSummaries().map((s) => s.value);
    expect(before[0]).toMatch(/^100\.0+ m/);
    expect(before[1]).toMatch(/^30\.48\d* m/);
    const labelsBefore = labelsOf(measure);

    // The foot scan becomes active: the global factors change.
    measure.setUnitToMetres(US_SURVEY_FOOT);
    measure.setVerticalUnitToMetres(US_SURVEY_FOOT);
    expect(measure.getSummaries().map((s) => s.value)).toEqual(before);
    expect(labelsOf(measure)).toEqual(labelsBefore);

    // And a scan with no CRS at all becomes active.
    measure.setCrsKnown(false);
    measure.setUnitToMetres(1);
    const after = measure.getSummaries();
    expect(after.map((s) => s.value)).toEqual(before);
    expect(after.every((s) => !s.unitUnverified)).toBe(true);
    expect(after.map((s) => s.lineMetrics?.horizontalM)).toEqual([100, 100 * US_SURVEY_FOOT]);
  });

  it('the trust grade keeps the owner CRS verdict', async () => {
    const measure = await controller();
    measure.loadMeasurements([dist('a', ['layer-m'])]);
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).crsKnown).toBe(true);
    measure.setCrsKnown(false);
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).crsKnown).toBe(true);
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).unitToMetres).toBe(1);
  });

  it('a geographic owner refuses its distance while a projected active scan does not', async () => {
    const measure = await controller();
    FRAMES['layer-geo'] = frame(1, { geographic: true, projected: false });
    measure.loadMeasurements([dist('g', ['layer-geo']), dist('a', ['layer-m'])]);
    expect(labelsOf(measure)).toEqual([GEOGRAPHIC_NOT_AVAILABLE, expect.stringMatching(/^100\.0+ m/)]);
    delete FRAMES['layer-geo'];
  });

  it('a measurement spanning layers with different units reads as unverified', async () => {
    const measure = await controller();
    measure.loadMeasurements([dist('x', ['layer-m', 'layer-ft'])]);
    const [s] = measure.getSummaries();
    expect(s!.unitUnverified).toBe(true);
    expect(s!.value).toContain(UNIT_UNVERIFIED);
    expect(s!.value).not.toMatch(/ m\b/);
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).crsKnown).toBe(false);
  });

  it('a measurement naming no layer follows the active scan factors', async () => {
    const measure = await controller();
    measure.loadMeasurements([dist('u', null)]);
    expect(measure.getSummaries()[0]!.value).toMatch(/^100\.0+ m/);
    measure.setUnitToMetres(US_SURVEY_FOOT);
    expect(measure.getSummaries()[0]!.value).toMatch(/^30\.48\d* m/);
  });
});

describe('chain totals over several scans', () => {
  it('one shared unit frame is used as is', () => {
    expect(chainUnitFrame([frame(1), frame(1)])).toEqual({ frame: frame(1) });
  });

  it('different unit frames are refused, not summed', () => {
    const r = chainUnitFrame([frame(1), frame(US_SURVEY_FOOT)]);
    expect('refusal' in r && r.refusal).toMatch(/different units/);
  });
});

describe('the live readout and the file export agree, whichever scan is active', () => {
  const utm: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 12N', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1, isGeographic: false };
  const foot: CrsInfo = { ...utm, name: 'NAD83 / Colorado North (ftUS)', epsg: 2231, linearUnit: 'us-survey-foot', linearUnitToMetres: US_SURVEY_FOOT, verticalUnitToMetres: US_SURVEY_FOOT };

  it('a distance on the foot scan reads 30.48 m live and in the CSV under either active scan', async () => {
    const crsOf: Record<string, CrsInfo> = { a: foot, b: utm };
    const clouds = new Map(['a', 'b'].map((id) => [id, {
      name: `${id}.las`, sourceFormat: 'las', sourceOrigin: [500000, 4000000, 0], pointCount: 10,
      bounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }), metadata: { crs: crsOf[id] },
    } as unknown as PointCloud]));
    const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
    let active = 'b';
    const activate = (id: string): void => {
      active = id;
      svc.resolveForScan({ name: `${id}.las`, detected: crsOf[id], source: 'las-vlr' });
    };
    activate('b');
    const measure = await controller();
    const units = bindMeasureUnitFrames(measure, {
      activeId: () => active, clouds: () => ['a', 'b'], cloud: (id) => clouds.get(id),
      stableIdFor: (id) => `layer-${id}`, crs: svc,
    });
    measure.loadMeasurements([dist('on-a', ['layer-a']), dist('on-b', ['layer-b'])]);
    const files: string[] = [];
    const deps = {
      measure, geo: () => geoContextForCloud(clouds.get(active)!, svc.current()), upAxis: () => 'z',
      layers: { stableIdFor: (id: string) => `layer-${id}`, view: { clouds: () => ['a', 'b'], getCloud: (id: string) => clouds.get(id), layerProjectOffset: () => null } },
      frameSource: { activeId: () => active, activeGeo: () => geoContextForCloud(clouds.get(active)!, svc.current()), activeUpAxis: () => 'z', cloud: (id: string) => clouds.get(id), classificationEpoch: () => 0, crs: svc },
      refuse: () => {}, notify: () => {}, baseName: (s: string) => s.replace('.las', ''),
      downloadText: (_n: string, text: string) => files.push(text),
      loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) }),
      loadMeasurementReport: async () => ({}),
      activeClassificationEpoch: () => 0, appVersion: 'test', now: () => '2026-10-15T00:00:00Z',
    } as unknown as MeasurementExportActionDeps;

    for (const id of ['b', 'a']) {
      activate(id);
      units.onCrsChange();
      const live = measure.getSummaries().map((s) => s.lineMetrics!.horizontalM);
      expect(live[0]).toBeCloseTo(100 * US_SURVEY_FOOT, 9);
      expect(live[1]).toBeCloseTo(100, 9);
      // One file per measurement: each is written through its own scan's frame.
      for (const only of [0, 1]) {
        const all = measure.getMeasurements().slice();
        measure.loadMeasurements([all[only]!]);
        files.length = 0;
        await exportMeasurementsFile('csv', deps);
        measure.loadMeasurements(all);
        const [header, row] = files[0]!.split('\n');
        const i = header!.split(',').indexOf('length_m');
        expect(Number(row!.split(',')[i])).toBeCloseTo(live[only]!, 3);
      }
    }

    // Work naming a scan that is no longer open has no units to read in.
    measure.loadMeasurements([dist('gone', ['layer-closed'])]);
    const [gone] = measure.getSummaries();
    expect(gone!.unitUnverified).toBe(true);
    expect(gone!.value).toContain(UNIT_UNVERIFIED);
  });
});
