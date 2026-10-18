/**
 * measurementLayerUpFrame.test.ts
 *
 * A measurement reads its height, grade, plan figures, profile and volume
 * along its owning layer's RESOLVED up axis, the axis terrain and conversion
 * use. A PLY under a projected CRS stores easting, northing and height in X, Y
 * and Z; the measurement path read the format alone and took Y as height, so a
 * 100 m rise read 0.0 cm and a 100 m step north read 100 m, in the panel and in
 * the CSV, while the terrain analysis of the same layer was correct.
 *
 * Driven through the real loader, CrsService, unit binding, controller and the
 * application's export action. Pinned: the two failing readouts and a LAS
 * control; every axis-dependent kind; GeoJSON permission; a glTF under a CRS
 * withheld with its reason; assigning, replacing and clearing the CRS after a
 * measurement exists (values, derived results and export permission follow,
 * coordinates never move); the owner frame through activating another layer,
 * removing one, a session round trip and an export whose serializer resolves
 * after the frame changed.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadPly } from '../src/io/loadPly';
import { PointCloud } from '../src/model/PointCloud';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import { bindMeasureUnitFrames, type MeasureUnitFrames } from '../src/app/measureLayerUnits';
import { activeSpatialUpAxis, withholdUnresolvedUp } from '../src/app/layerUpFrames';
import { geoContextForCloud } from '../src/app/reportExport';
import { exportMeasurementIntegrityReport, exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import { sourceUnitKey } from '../src/export/measurementExport';
import * as reportSerializers from '../src/export/measurementReport';
import type { SourceFormat } from '../src/io/sniffFormat';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const Z: Vec3 = [0, 0, 1];
const Y: Vec3 = [0, 1, 0];

function memoryPort(): CrsOverridePort {
  const store = new Map<string, unknown>();
  return {
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => void store.delete(k),
  } as CrsOverridePort;
}

/** Two points at UTM 13N coordinates: B is 30 m north of A and 70 m above it. */
async function surveyCloud(format: SourceFormat, name: string, extra: readonly string[] = []): Promise<PointCloud> {
  const rows = ['500000 4000000 100', '500000 4000030 170', '500040 4000000 100', ...extra];
  const text = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows.join('\n')}\n`;
  const ply = await loadPly(new TextEncoder().encode(text).buffer as ArrayBuffer, name);
  return format === 'ply' ? ply : new PointCloud({ positions: ply.positions.slice(), origin: [...ply.sourceOrigin] as [number, number, number], sourceFormat: format, name });
}

/** A CSV row's vertical column: metres when the scale is known, source units otherwise. */
const vert = (r: Record<string, string>): number => Number(r.vertical_m ?? r[sourceUnitKey('vertical_m')]);

/** The number a panel row leads with. */
const num = (v: string): number => Number.parseFloat(v);

const pt = (c: PointCloud, i: number): Vec3 => [c.positions[i * 3]!, c.positions[i * 3 + 1]!, c.positions[i * 3 + 2]!];

interface Layer { readonly id: string; readonly stable: string; readonly cloud: PointCloud }

/** The running app around a real controller: layers, the active one, the CRS service and the binding main.ts makes. */
class World {
  readonly crs: CrsService;
  readonly layers: Layer[] = [];
  active: string | null = null;
  measure!: MC;
  units!: MeasureUnitFrames;
  realigns = 0;

  constructor(port: CrsOverridePort = memoryPort()) {
    this.crs = new CrsService(port);
  }

  async init(): Promise<this> {
    const { MeasureController } = await import('../src/render/measure/MeasureController');
    this.measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
    this.measure.setLayerResolver((l) => (typeof l === 'string' ? l : null));
    this.units = bindMeasureUnitFrames(this.measure, {
      activeId: () => this.active,
      clouds: () => this.layers.map((l) => l.id),
      cloud: (id) => this.layers.find((l) => l.id === id)?.cloud,
      stableIdFor: (id) => this.layers.find((l) => l.id === id)?.stable ?? null,
      crs: this.crs,
      realignUp: () => { this.realigns++; },
    });
    return this;
  }

  cloudOf(id: string): PointCloud { return this.layers.find((l) => l.id === id)!.cloud; }

  /** Open a layer and make it active, as a load does. */
  open(id: string, cloud: PointCloud): void {
    this.layers.push({ id, stable: `layer-${id}`, cloud });
    this.activate(id);
  }

  activate(id: string): void {
    this.active = id;
    const c = this.cloudOf(id);
    this.crs.resolveForScan({ name: c.name, detected: c.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(c) });
    this.units.onCrsChange();
  }

  remove(id: string): void {
    this.layers.splice(this.layers.findIndex((l) => l.id === id), 1);
    if (this.active === id) this.activate(this.layers[this.layers.length - 1]!.id);
    else this.units.onCrsChange();
  }

  /** The Inspector's CRS choice on the active layer. */
  assign(epsg: number | null): void {
    this.crs.setOverride({ override: epsg === null ? { kind: 'detected', epsg: null } : { kind: 'projected', epsg }, detected: undefined, source: 'las-vlr' });
    this.units.onCrsChange();
  }

  place(kind: MeasurementKind, layer: string, points: Vec3[]): Measurement {
    this.measure.setActive(true);
    this.measure.setKind(kind);
    for (const p of points) this.measure.addPoint(p, `layer-${layer}`);
    this.measure.finishCurrent();
    return this.measure.getMeasurements().at(-1)!;
  }

  load(ms: Measurement[]): void { this.measure.loadMeasurements(ms); }

  value(i = 0): string { return this.measure.getSummaries()[i]!.value; }

  deps(over: Partial<MeasurementExportActionDeps> = {}): { deps: MeasurementExportActionDeps; files: string[]; refusals: string[] } {
    const files: string[] = [];
    const refusals: string[] = [];
    const activeCloud = (): PointCloud | undefined => (this.active ? this.cloudOf(this.active) : undefined);
    const geo = () => geoContextForCloud(activeCloud()!, this.crs.current());
    const upAxis = () => activeSpatialUpAxis({ activeCloud, streaming: () => false, crs: this.crs });
    const deps = {
      measure: this.measure,
      geo,
      upAxis,
      layers: { stableIdFor: (id: string) => `layer-${id}`, view: { clouds: () => this.layers.map((l) => l.id), getCloud: (id: string) => this.cloudOf(id), layerProjectOffset: () => null } },
      frameSource: { activeId: () => this.active, activeGeo: geo, activeUpAxis: upAxis, cloud: (id: string) => this.layers.find((l) => l.id === id)?.cloud, classificationEpoch: () => 0, crs: this.crs },
      refuse: (s: string) => refusals.push(s), notify: () => {}, baseName: (s: string) => s,
      downloadText: (_n: string, text: string) => files.push(text),
      loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) }),
      loadMeasurementReport: async () => ({ ...reportSerializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) }),
      activeClassificationEpoch: () => 0, appVersion: 'test', now: () => '2026-10-18T00:00:00Z',
      ...over,
    } as unknown as MeasurementExportActionDeps;
    return { deps, files, refusals };
  }

  async csv(over: Partial<MeasurementExportActionDeps> = {}): Promise<{ rows: Record<string, string>[]; refusals: string[] }> {
    const { deps, files, refusals } = this.deps(over);
    await exportMeasurementsFile('csv', deps);
    if (!files[0]) return { rows: [], refusals };
    const [head, ...lines] = files[0].trim().split('\n');
    const cols = head!.split(',');
    return { rows: lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i]!, v]))), refusals };
  }
}

const heightOf = (w: World, layer: string): Measurement => {
  const c = w.cloudOf(layer);
  return { id: `h-${layer}`, kind: 'height', name: 'Survey height', closed: false, points: [pt(c, 0), pt(c, 1)], pickLayers: [`layer-${layer}`], owner: { layerId: `layer-${layer}`, frame: 'project' } } as Measurement;
};

describe('the two failing readouts, with a LAS control', () => {
  it.each([
    ['ply', 'vertical', ['500000 4000000 200'], 100],
    ['ply', 'northing', ['500000 4000100 100'], 0],
    ['las', 'vertical', ['500000 4000000 200'], 100],
  ] as const)('%s %s +100 m reads %s m in the panel and the CSV', async (format, _dir, extra, expected) => {
    const w = await new World().init();
    const cloud = await surveyCloud(format, `axis.${format}`, extra);
    w.open('a', cloud);
    w.assign(32613);
    w.load([{ ...heightOf(w, 'a'), points: [pt(cloud, 0), pt(cloud, 3)] }]);
    expect(w.value()).toBe(expected === 0 ? '0.0 cm' : '100.00 m');
    const { rows } = await w.csv();
    expect(Number(rows[0]!.vertical_m)).toBeCloseTo(expected, 6);
    expect(w.measure.unitFrameOf(w.measure.getMeasurements()[0]).upBasis).toBe(format === 'las' ? 'specification' : 'crs');
  });
});

describe('every axis-dependent kind on a georeferenced PLY reads along Z', () => {
  it('height, horizontal distance, grade, horizontal area and box height, in the panel and the CSV', async () => {
    const w = await new World().init();
    const c = await surveyCloud('ply', 'site.ply');
    w.open('a', c);
    w.assign(32613);
    const [a, b, e] = [pt(c, 0), pt(c, 1), pt(c, 2)];
    const own = { pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' as const } };
    w.load([
      { id: 'h', kind: 'height', name: 'h', closed: false, points: [a, b], ...own },
      { id: 'd', kind: 'distance', name: 'd', closed: false, points: [a, b], ...own },
      { id: 's', kind: 'slope', name: 's', closed: false, points: [a, b], ...own },
      { id: 'r', kind: 'area', name: 'r', closed: true, points: [a, e, [e[0], e[1] + 30, e[2] + 70], b], ...own },
      { id: 'x', kind: 'box', name: 'x', closed: false, points: [a, [a[0] + 10, a[1] + 10, a[2] + 70]], ...own },
    ] as Measurement[]);
    const s = w.measure.getSummaries();
    expect(num(s[0]!.value)).toBeCloseTo(70, 3);
    expect(s[1]!.lineMetrics!.verticalM).toBeCloseTo(70, 9);
    expect(s[1]!.lineMetrics!.horizontalM).toBeCloseTo(30, 9);
    const { rows } = await w.csv();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Number(by.h!.vertical_m)).toBeCloseTo(70, 6);
    expect(Number(by.h!.horizontal_m)).toBeCloseTo(30, 6);
    expect(Number(by.d!.length_m)).toBeCloseTo(Math.hypot(30, 70), 3);
    expect(Number(by.s!.rise_m)).toBeCloseTo(70, 6);
    expect(Number(by.s!.run_m)).toBeCloseTo(30, 6);
    expect(Number(by.s!.grade_pct)).toBeCloseTo((70 / 30) * 100, 3);
    // The plan footprint of a 40 x 30 rectangle tilted up 70 m.
    expect(Number(by.r!.horizontal_area_m2)).toBeCloseTo(40 * 30, 4);
    expect(Number(by.x!.height_m)).toBeCloseTo(70, 6);
  });

  it('a profile and a volume are cut along Z, and re-cut when the CRS that settles the axis arrives later', async () => {
    const w = await new World().init();
    const c = await surveyCloud('ply', 'site.ply');
    w.open('a', c);
    const ups: string[] = [];
    w.measure.setProfileSampler(() => {
      ups.push(`profile ${w.measure.worldUp.join(',')}`);
      return [{ distance: 0, height: 0 }, { distance: 1, height: 1 }];
    });
    w.measure.setVolumeSampler((_poly, _ref, up) => {
      ups.push(`volume ${up!.join(',')}`);
      return { fill: 1, cut: 0, net: 1, referenceZ: 0, footprintArea: 1, pointsInPolygon: 1000, densityNative: 1, confidence: 'high' } as never;
    });
    const [a, b, e] = [pt(c, 0), pt(c, 1), pt(c, 2)];
    w.place('profile', 'a', [a, e]);
    w.place('volume', 'a', [a, e, b]);
    expect(ups).toEqual(['profile 0,1,0', 'volume 0,1,0']);
    const before = w.measure.getMeasurements().map((m) => structuredClone(m.points));
    w.assign(32613);
    expect(ups.slice(2)).toEqual(['profile 0,0,1', 'volume 0,0,1']);
    // Stored coordinates never move.
    expect(w.measure.getMeasurements().map((m) => m.points)).toEqual(before);
    // A frame that did not move re-cuts nothing.
    w.units.onCrsChange();
    expect(ups).toHaveLength(4);
  });
});

describe('a glTF under a CRS has no up axis to measure along', () => {
  it('withholds axis-dependent figures with the reason, keeps a 3D length, refuses the CSV and leaves the PDF set', async () => {
    const w = await new World().init();
    const c = await surveyCloud('glb', 'site.glb');
    w.open('a', c);
    w.assign(32613);
    const [a, b] = [pt(c, 0), pt(c, 1)];
    const own = { pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'project' as const } };
    w.load([
      { id: 'h', kind: 'height', name: 'h', closed: false, points: [a, b], ...own },
      { id: 'd', kind: 'distance', name: 'd', closed: false, points: [a, b], ...own },
    ] as Measurement[]);
    const s = w.measure.getSummaries();
    expect(s[0]!.value).toMatch(/^not available: no up axis; glTF stores Y as the up axis by specification/);
    expect(s[0]!.value).toMatch(/set the scan's coordinate system to Local/);
    expect(num(s[1]!.value)).toBeCloseTo(Math.hypot(30, 70), 3);
    expect(s[1]!.lineMetrics).toBeUndefined();
    const { rows, refusals } = await w.csv();
    expect(rows).toEqual([]);
    expect(refusals[0]).toMatch(/^Not exported: no up axis; glTF stores Y/);
    const pdf = withholdUnresolvedUp({ own: w.measure.getMeasurements(), withheldCount: 0, withheld: null }, (m) => w.measure.unitFrameOf(m).upRefusal);
    expect(pdf.own).toEqual([]);
    expect(pdf.withheld).toMatch(/^2 measurements were left out: their layer has no resolved up axis\. glTF stores Y/);
  });
});

describe('assigning, replacing and clearing the CRS after a measurement exists', () => {
  it('moves the value and the export permission with the frame, never the coordinates', async () => {
    const w = await new World().init();
    w.open('a', await surveyCloud('ply', 'site.ply'));
    w.load([heightOf(w, 'a')]);
    const points = structuredClone(w.measure.getMeasurements()[0]!.points);
    const geojson = async (): Promise<{ ok: boolean; refusals: string[] }> => {
      const { deps, files, refusals } = w.deps();
      await exportMeasurementsFile('geojson', deps);
      return { ok: files.length === 1, refusals };
    };

    // No CRS: the PLY rule reads Y, 30 m; the lon/lat placement is refused.
    expect(num(w.value())).toBeCloseTo(30, 3);
    expect(w.measure.unitFrameOf(w.measure.getMeasurements()[0]).upBasis).toBe('explicit');
    expect(w.measure.upFor(w.measure.getMeasurements()[0])).toEqual(Y);
    expect(vert((await w.csv()).rows[0]!)).toBeCloseTo(30, 6);
    expect((await geojson()).ok).toBe(false);

    w.assign(32613);
    expect(num(w.value())).toBeCloseTo(70, 3);
    expect(Number((await w.csv()).rows[0]!.vertical_m)).toBeCloseTo(70, 6);
    expect(await geojson()).toEqual({ ok: true, refusals: [] });

    w.assign(32612);
    expect(num(w.value())).toBeCloseTo(70, 3);
    expect((await geojson()).ok).toBe(true);

    w.assign(null);
    expect(num(w.value())).toBeCloseTo(30, 3);
    expect(vert((await w.csv()).rows[0]!)).toBeCloseTo(30, 6);
    expect((await geojson()).ok).toBe(false);

    expect(w.measure.getMeasurements()[0]!.points).toEqual(points);
    expect(w.realigns).toBeGreaterThanOrEqual(4);
  });
});

describe('the owner frame holds through the app around it', () => {
  async function twoLayers(): Promise<World> {
    const w = await new World().init();
    w.open('p', await surveyCloud('ply', 'site.ply'));
    w.assign(32613);
    w.open('l', await surveyCloud('las', 'control.las'));
    w.load([heightOf(w, 'p'), heightOf(w, 'l')]);
    return w;
  }

  it('while another layer is active, and after a layer is removed', async () => {
    const w = await twoLayers();
    expect(w.active).toBe('l');
    expect(num(w.value(0))).toBeCloseTo(70, 3);
    expect(num(w.value(1))).toBeCloseTo(70, 3);
    expect(w.measure.upFor(w.measure.getMeasurements()[0])).toEqual(Z);
    // The PLY's measurements alone export through its own frame.
    w.load([heightOf(w, 'p')]);
    expect(Number((await w.csv()).rows[0]!.vertical_m)).toBeCloseTo(70, 6);
    w.activate('p');
    expect(num(w.value(0))).toBeCloseTo(70, 3);
    w.remove('l');
    expect(num(w.value(0))).toBeCloseTo(70, 3);
    expect(Number((await w.csv()).rows[0]!.vertical_m)).toBeCloseTo(70, 6);
  });

  it('through a session round trip: saved work reopened under the remembered CRS', async () => {
    const port = memoryPort();
    const w = await new World(port).init();
    w.open('p', await surveyCloud('ply', 'site.ply'));
    w.assign(32613);
    w.load([heightOf(w, 'p')]);
    const saved = JSON.parse(JSON.stringify(w.measure.getMeasurements())) as Measurement[];
    const reopened = await new World(port).init();
    reopened.open('p', await surveyCloud('ply', 'site.ply'));
    reopened.load(saved);
    expect(num(reopened.value())).toBeCloseTo(70, 3);
    expect(reopened.measure.upFor(reopened.measure.getMeasurements()[0])).toEqual(Z);
  });

  it('when the serializer resolves after the frame changed, the file keeps the frame the export started in', async () => {
    const w = await new World().init();
    w.open('p', await surveyCloud('ply', 'site.ply'));
    w.assign(32613);
    w.load([heightOf(w, 'p')]);
    const late = async () => {
      await Promise.resolve();
      w.assign(null);
      return { ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null }) };
    };
    const { rows } = await w.csv({ loadMeasurementExport: late as never });
    expect(Number(rows[0]!.vertical_m)).toBeCloseTo(70, 6);
    expect(num(w.value())).toBeCloseTo(30, 3);
    expect(vert((await w.csv()).rows[0]!)).toBeCloseTo(30, 6);
  });

  it('the integrity report states the height along the owner frame', async () => {
    const w = await twoLayers();
    w.load([heightOf(w, 'p')]);
    const { deps, files, refusals } = w.deps();
    await exportMeasurementIntegrityReport(deps);
    expect(refusals).toEqual([]);
    const report = JSON.parse(files[0]!) as { findings: { label: string; value: number; unit: string }[] };
    expect(report.findings).toEqual([{ label: 'Survey height', value: 70, unit: 'm' }]);
  });
});
