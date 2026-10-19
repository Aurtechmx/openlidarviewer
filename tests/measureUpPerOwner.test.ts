/**
 * Each measurement's orientation-dependent figures (height, grade, profile,
 * box, cut/fill, horizontal area) use the up axis of the layer it was taken
 * on. A Z-up survey (LAS) and a Y-up scan (PLY) share one render space and one
 * navigation up; whichever is active, a 5 m LAS height stays 5 m, in the panel,
 * the chain totals and the CSV. A measurement whose points sit on layers with
 * different up axes has no common vertical and is withheld with its reason.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, MeasureUnitFrame, Vec3 } from '../src/render/measure/types';
import { UP_AXIS_CONFLICT } from '../src/render/measure/types';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import { bindMeasureUnitFrames, chainUnitFrame } from '../src/app/measureLayerUnits';
import { exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import { geoContextForCloud } from '../src/app/reportExport';
import * as serializers from '../src/export/measurementExport';
import { CrsService } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { PointCloud } from '../src/model/PointCloud';
import { sceneUpOf, upOfFormat } from '../src/io/sniffFormat';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const Z: Vec3 = [0, 0, 1];
const Y: Vec3 = [0, 1, 0];

const frame = (up: Vec3): MeasureUnitFrame => ({
  unitToMetres: 1, verticalUnitToMetres: 1, verticalUnitKnown: true, verticalUnitInvalid: false, crsKnown: true,
  geographic: false, verticalRefused: false, projected: true, up,
});
const FRAMES: Record<string, MeasureUnitFrame> = { 'layer-las': frame(Z), 'layer-ply': frame(Y) };

function m(id: string, kind: Measurement['kind'], points: Vec3[], layers: string[]): Measurement {
  return { id, kind, name: id, closed: kind === 'volume', points, pickLayers: layers, owner: { layerId: layers[0]!, frame: 'project' } } as Measurement;
}

const LAS_WORK = (): Measurement[] => [
  m('h', 'height', [[4, 2, 1], [4, 2, 6]], ['layer-las']),
  m('s', 'slope', [[4, 2, 1], [8, 2, 3]], ['layer-las']),
  m('p', 'profile', [[2, 2, 0], [12, 2, 0]], ['layer-las']),
  m('b', 'box', [[4, 2, 1], [7, 6, 3]], ['layer-las']),
  m('d', 'distance', [[4, 2, 1], [7, 6, 6]], ['layer-las']),
  m('a', 'area', [[0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, 5]], ['layer-las']),
];

async function controller(sceneUp: Vec3): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: sceneUp, origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  measure.setUnitResolver((layerId) => FRAMES[layerId] ?? null);
  return measure;
}

const labelsOf = (measure: MC): string[] =>
  (measure as unknown as { _buildModel(): { labels: { text: string; primary: boolean }[] } })
    ._buildModel().labels.filter((l) => l.primary).map((l) => l.text);

describe('per-owner up axis in the live readouts', () => {
  it('a LAS height reads 5 m whether the scene is Z-up or Y-up', async () => {
    const measure = await controller(Z);
    measure.loadMeasurements([LAS_WORK()[0]!]);
    expect(measure.getSummaries()[0]!.value).toMatch(/^5\.0000 m/);
    measure.setContext({ worldUp: Y, origin: null });
    expect(measure.getSummaries()[0]!.value).toMatch(/^5\.0000 m/);
    expect(labelsOf(measure)[0]).toMatch(/^5\.0000 m/);
  });

  it('slope, profile, box, distance breakdown and horizontal area do not move with the scene up', async () => {
    const measure = await controller(Z);
    measure.loadMeasurements(LAS_WORK());
    const before = measure.getSummaries();
    const labels = labelsOf(measure);
    measure.setContext({ worldUp: Y, origin: null });
    const after = measure.getSummaries();
    expect(after.map((s) => s.value)).toEqual(before.map((s) => s.value));
    expect(after.map((s) => s.lineMetrics)).toEqual(before.map((s) => s.lineMetrics));
    expect(after.map((s) => s.areaMetrics)).toEqual(before.map((s) => s.areaMetrics));
    expect(labelsOf(measure)).toEqual(labels);
    expect(after[4]!.lineMetrics!.verticalM).toBeCloseTo(5, 12);
  });

  it('a PLY height reads along Y while a Z-up scan drives the scene', async () => {
    const measure = await controller(Z);
    measure.loadMeasurements([m('ph', 'height', [[0, 0, 0], [0, 1, 0]], ['layer-ply'])]);
    expect(measure.getSummaries()[0]!.value).toMatch(/^1\.0000 m/);
    expect(measure.upFor(measure.getMeasurements()[0])).toEqual(Y);
    // The scene up is untouched outside the measurement's own frame.
    expect(measure.worldUp).toEqual(Z);
  });

  it('points on layers with different up axes are not combined', async () => {
    const measure = await controller(Z);
    const mixed = (kind: Measurement['kind'], points: Vec3[]) => m(`x-${kind}`, kind, points, ['layer-las', 'layer-ply']);
    measure.loadMeasurements([
      mixed('height', [[4, 2, 1], [1, 0.5, 0.25]]),
      mixed('slope', [[4, 2, 1], [1, 0.5, 0.25]]),
      mixed('profile', [[4, 2, 1], [1, 0.5, 0.25]]),
      mixed('box', [[4, 2, 1], [1, 0.5, 0.25]]),
      mixed('distance', [[0, 0, 0], [3, 4, 0]]),
    ]);
    const s = measure.getSummaries();
    expect(s.slice(0, 4).map((x) => x.value)).toEqual(Array(4).fill(UP_AXIS_CONFLICT));
    // A 3D length needs no up axis; its horizontal/vertical split does.
    expect(s[4]!.value).toBe('5.0000 m');
    expect(s[4]!.lineMetrics).toBeUndefined();
    expect(labelsOf(measure).slice(0, 4)).toEqual(Array(4).fill(UP_AXIS_CONFLICT));
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).upConflict).toBe(true);
  });
});

describe('per-owner up resolution', () => {
  it('Z-up survey formats and Y-up mesh formats', () => {
    for (const f of ['las', 'laz', 'e57', 'xyz', 'pts', 'ptx', 'pcd'] as const) expect(upOfFormat(f)).toEqual(Z);
    for (const f of ['ply', 'obj', 'gltf', 'glb'] as const) expect(upOfFormat(f as never)).toEqual(Y);
  });

  it('the scene up follows the named layer, else the last one added', () => {
    const layers = new Map([
      ['a', { cloud: { sourceFormat: 'las' } }],
      ['b', { cloud: { sourceFormat: 'ply' } }],
    ]) as unknown as Parameters<typeof sceneUpOf>[0];
    expect(sceneUpOf(layers, 'a')).toEqual(Z);
    expect(sceneUpOf(layers, 'b')).toEqual(Y);
    expect(sceneUpOf(layers, null)).toEqual(Y);
    expect(sceneUpOf(layers, 'gone')).toEqual(Y);
    expect(sceneUpOf(new Map() as unknown as Parameters<typeof sceneUpOf>[0], null)).toBeNull();
  });

  it('a layer frame carries its own up', async () => {
    const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
    const clouds = new Map<string, PointCloud>([
      ['l', { name: 'l.las', sourceFormat: 'las', metadata: {} } as unknown as PointCloud],
      ['p', { name: 'p.ply', sourceFormat: 'ply', metadata: {} } as unknown as PointCloud],
    ]);
    const measure = await controller(Y);
    bindMeasureUnitFrames(measure, { activeId: () => 'p', clouds: () => ['l', 'p'], cloud: (id) => clouds.get(id), stableIdFor: (id) => `layer-${id}`, crs: svc });
    measure.loadMeasurements([m('h', 'height', [[4, 2, 1], [4, 2, 6]], ['layer-l'])]);
    expect(measure.unitFrameOf(measure.getMeasurements()[0]!).up).toEqual(Z);
    expect(measure.getSummaries()[0]!.value).toMatch(/^5\b/);
  });

  it('chain totals refuse measurements on layers with different up axes', () => {
    const r = chainUnitFrame([frame(Z), frame(Y)]);
    expect('refusal' in r && r.refusal).toMatch(/different up axes/);
    expect(chainUnitFrame([frame(Z), frame(Z)])).toEqual({ frame: frame(Z) });
  });
});

describe('the CSV uses the owner up, whichever layer is active', () => {
  it('a LAS height exports vertical_m 5 while the Y-up PLY is active', async () => {
    const utm: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1, isGeographic: false };
    const clouds = new Map<string, PointCloud>([
      ['l', { name: 'l.las', sourceFormat: 'las', sourceOrigin: [500000, 4000000, 0], pointCount: 10, bounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }), metadata: { crs: utm } } as unknown as PointCloud],
      ['p', { name: 'p.ply', sourceFormat: 'ply', sourceOrigin: [0, 0, 0], pointCount: 10, bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }), metadata: {} } as unknown as PointCloud],
    ]);
    const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
    svc.resolveForScan({ name: 'p.ply', detected: undefined, source: 'las-vlr' });
    const measure = await controller(Y);
    bindMeasureUnitFrames(measure, { activeId: () => 'p', clouds: () => ['l', 'p'], cloud: (id) => clouds.get(id), stableIdFor: (id) => `layer-${id}`, crs: svc });
    measure.loadMeasurements([m('h', 'height', [[4, 2, 1], [4, 2, 6]], ['layer-l'])]);
    const files: string[] = [];
    const refused: string[] = [];
    const deps = {
      measure, geo: () => geoContextForCloud(clouds.get('p')!, svc.current()), upAxis: () => 'unknown',
      layers: { stableIdFor: (id: string) => `layer-${id}`, view: { clouds: () => ['l', 'p'], getCloud: (id: string) => clouds.get(id), layerProjectOffset: () => null } },
      frameSource: { activeId: () => 'p', activeGeo: () => geoContextForCloud(clouds.get('p')!, svc.current()), activeUpAxis: () => 'unknown', cloud: (id: string) => clouds.get(id), classificationEpoch: () => 0, crs: svc },
      refuse: (s: string) => refused.push(s), notify: () => {}, baseName: (s: string) => s.replace(/\.\w+$/, ''),
      downloadText: (_n: string, text: string) => files.push(text),
      loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) }),
      loadMeasurementReport: async () => ({}),
      activeClassificationEpoch: () => 0, appVersion: 'test', now: () => '2026-10-15T00:00:00Z',
    } as unknown as MeasurementExportActionDeps;
    await exportMeasurementsFile('csv', deps);
    expect(refused).toEqual([]);
    const [header, row] = files[0]!.split('\n');
    expect(Number(row!.split(',')[header!.split(',').indexOf('vertical_m')])).toBe(5);
  });
});

describe('work whose owner layer is not open', () => {
  it('withholds height, grade and the other up-dependent figures instead of using the active layer\'s axis', async () => {
    const { UNRESOLVED_UNIT_FRAME } = await import('../src/render/measure/types');
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    measure.setContext({ worldUp: Z, origin: null });
    measure.setCrsKnown(true);
    measure.setUnitToMetres(1);
    // The resolver the app binds answers UNRESOLVED_UNIT_FRAME for a layer id no open layer carries.
    measure.setUnitResolver((layerId) => FRAMES[layerId] ?? UNRESOLVED_UNIT_FRAME);
    measure.loadMeasurements([
      m('gone-h', 'height', [[0, 0, 0], [0, 0, 6]], ['layer-gone']),
      m('gone-d', 'distance', [[0, 0, 0], [3, 4, 0]], ['layer-gone']),
      m('open-h', 'height', [[0, 0, 0], [0, 0, 6]], ['layer-las']),
    ]);
    const s = measure.getSummaries();
    expect(s[0]!.value).toMatch(/^not available: no up axis; owner layer not open/);
    expect(s[0]!.value).not.toMatch(/\d m/);
    // A 3D length needs no up axis, only a unit it cannot verify.
    expect(s[1]!.lineMetrics).toBeUndefined();
    expect(s[2]!.value).toMatch(/^6\.0000 m/);
  });
});
