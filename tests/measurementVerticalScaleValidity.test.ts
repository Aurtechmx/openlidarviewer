/**
 * measurementVerticalScaleValidity.test.ts — a measurement's vertical scale is
 * valid, absent or invalid, and every surface agrees on what that permits.
 *
 * A height needs a valid vertical scale; a 3D length, tilted area, angle,
 * grade, profile, box or volume needs every scale it reads to be valid; a
 * purely horizontal figure needs only its own. A declared vertical unit that
 * cannot be read (here an angular VerticalUnitsGeoKey) is never converted with
 * the horizontal factor: the live readout, the trust grade, the CSV, the
 * GeoJSON, the KML, the PDF rows, the findings and the integrity report all
 * withhold it with one reason, on the active layer and on any other layer,
 * through a delayed export and through a saved session.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { writeLas, writeLas14 } from '../src/convert/writeLas';
import { parseLasHeader } from '../src/io/lasHeader';
import { wktForEpsg } from '../src/io/epsgWkt';
import { CrsService } from '../src/geo/CrsService';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import { spatialContextFrom, volumeClaimRefusal } from '../src/geo/SpatialContext';
import { frameScalars, measureUnitFrameOf } from '../src/app/measurementExportFrame';
import { bindMeasureUnitFrames } from '../src/app/measureLayerUnits';
import { exportMeasurementsFile, exportMeasurementIntegrityReport, collectMeasurementFindings, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import { geoContextForCloud } from '../src/app/reportExport';
import * as serializers from '../src/export/measurementExport';
import * as reportSerializers from '../src/export/measurementReport';
import { buildKml } from '../src/export/kmlExport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { aggregate } from '../src/render/measure/measurementChains';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';
import { profileCsvRefusal } from '../src/render/measure/profileSummary';
import { VERTICAL_SCALE_NOT_AVAILABLE, type Measurement } from '../src/render/measure/types';
import { PointCloud } from '../src/model/PointCloud';
import type { CrsInfo } from '../src/io/crs';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const geom = { count: 2, x: new Float64Array([500000, 500000]), y: new Float64Array([4000000, 4000000]), z: new Float64Array([100, 200]) };
const parse = (b: Uint8Array): CrsInfo => parseLasHeader(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer).crs!;
/** NAVD88 beside an angular VerticalUnitsGeoKey: a vertical unit that cannot be read. */
const INVALID = parse(writeLas(geom, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9102 }));
const wktWith = (unit: string): CrsInfo =>
  parse(writeLas14(geom, { wkt: `COMPD_CS["UTM and local height",${wktForEpsg(32613)},VERT_CS["Local height",VERT_DATUM["Local datum",2005],${unit},AXIS["Up",UP]]]` }));
const YARD = wktWith('UNIT["yard",0.9144]');
const METRE = wktWith('UNIT["metre",1]');

const m = (id: string, kind: Measurement['kind'], points: Measurement['points'], layer = 'layer-a', extra: Partial<Measurement> = {}): Measurement =>
  ({ id, name: `${kind} ${id}`, kind, closed: kind === 'area' || kind === 'volume', points, pickLayers: [layer], owner: { layerId: layer, frame: 'project' }, ...extra }) as Measurement;

/** One of each kind, every one spanning the vertical. */
const ALL_KINDS = (layer = 'layer-a'): Measurement[] => [
  m('h', 'height', [[0, 0, 0], [30, 40, 100]], layer),
  m('d', 'distance', [[0, 0, 0], [30, 40, 100]], layer),
  m('p', 'polyline', [[0, 0, 0], [30, 40, 100], [30, 0, 100]], layer),
  m('a', 'area', [[0, 0, 0], [10, 0, 0], [10, 10, 10], [0, 10, 10]], layer),
  m('g', 'angle', [[0, 0, 10], [0, 0, 0], [10, 0, 0]], layer),
  m('s', 'slope', [[0, 0, 0], [30, 40, 100]], layer),
  m('r', 'profile', [[0, 0, 0], [30, 40, 100]], layer),
  m('b', 'box', [[0, 0, 0], [10, 20, 5]], layer),
  m('v', 'volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], layer, { volume: { cut: 2, fill: 5, net: 3 } } as Partial<Measurement>),
];

interface Scan { readonly id: string; readonly stable: string; readonly file: string; readonly crs: CrsInfo }

async function world(scans: readonly Scan[], activeId: string) {
  const svc = new CrsService({ get: () => undefined, set: () => undefined, clear: () => undefined });
  const byId = new Map(scans.map((s) => [s.id, s]));
  const clouds = new Map(scans.map((s) => [s.id, new PointCloud({
    name: s.file, sourceFormat: 'las', positions: Float32Array.from([0, 0, 0, 0, 0, 100]), origin: [500000, 4000000, 100], metadata: { crs: s.crs },
  })]));
  const active = byId.get(activeId)!;
  svc.resolveForScan({ name: active.file, detected: active.crs, source: 'las-vlr' });
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {}, getPickRay: () => null, getPointAt: () => null } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  const units = bindMeasureUnitFrames(measure, {
    activeId: () => activeId, clouds: () => scans.map((s) => s.id), cloud: (id) => clouds.get(id), stableIdFor: (id) => byId.get(id)?.stable ?? null, crs: svc,
  });
  units.onCrsChange();
  const files: string[] = [];
  const refusals: string[] = [];
  const geo = () => geoContextForCloud(clouds.get(activeId)!, svc.current());
  const deps = (over: Partial<MeasurementExportActionDeps> = {}): MeasurementExportActionDeps => ({
    measure, geo, upAxis: () => 'z',
    layers: { stableIdFor: (id) => byId.get(id)?.stable ?? null, view: { clouds: () => scans.map((s) => s.id), getCloud: (id) => clouds.get(id) as never, layerProjectOffset: () => null } },
    frameSource: { activeId: () => activeId, activeGeo: geo, activeUpAxis: () => 'z', cloud: (id) => clouds.get(id), classificationEpoch: () => 0, crs: svc },
    refuse: (s) => refusals.push(s), notify: () => {}, baseName: (s) => s.replace(/\.las$/, ''), downloadText: (_n, text) => files.push(text),
    loadMeasurementExport: async () => ({ ...serializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null } as never) }),
    loadMeasurementReport: async () => ({ ...reportSerializers, resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'none', crsOrigin: null } as never) } as never),
    activeClassificationEpoch: () => 0, appVersion: 'test', now: () => '2026-10-17T00:00:00Z',
    ...over,
  } as MeasurementExportActionDeps);
  return { svc, measure, deps, files, refusals };
}

/** CSV rows keyed by measurement id, each a column → cell map. */
function csvRows(text: string): Map<string, Record<string, string>> {
  const [header, ...rows] = text.split('\n');
  const keys = header!.split(',');
  const out = new Map<string, Record<string, string>>();
  for (const row of rows) {
    // The evidence cell is last and may be quoted; metric cells never are.
    const cells = row.split(',');
    const rec: Record<string, string> = {};
    keys.forEach((k, i) => { rec[k] = k === 'evidence' ? cells.slice(i).join(',') : cells[i] ?? ''; });
    out.set(rec.id!, rec);
  }
  return out;
}

const METRIC_COLUMNS = ['length_m', 'horizontal_m', 'vertical_m', 'rise_m', 'run_m', 'grade_pct', 'angle_deg', 'area_m2', 'horizontal_area_m2', 'perimeter_m', 'width_m', 'depth_m', 'height_m', 'volume_m3', 'cut_m3', 'fill_m3', 'net_m3'];
/** The purely horizontal figures each kind keeps when only the vertical scale is invalid. */
const HORIZONTAL_KEPT: Record<string, readonly string[]> = { h: ['horizontal_m'], r: ['horizontal_m'], s: ['run_m'], a: ['horizontal_area_m2'], b: ['width_m', 'depth_m'], v: ['area_m2'], d: [], p: [], g: [] };

describe('an unreadable vertical unit withholds every figure that reads Z', () => {
  const scans = [{ id: 'a', stable: 'layer-a', file: 'invalid.las', crs: INVALID }];

  it('the frame carries the invalid state apart from its drawing factor', () => {
    const ctx = spatialContextFrom(INVALID);
    expect(ctx.verticalScaleState).toBe('invalid');
    const s = frameScalars(ctx);
    expect(s.verticalScaleInvalid).toBe(true);
    expect(measureUnitFrameOf(ctx).verticalUnitInvalid).toBe(true);
    expect(measureUnitFrameOf(ctx).verticalUnitKnown).toBe(false);
  });

  it('the live readout refuses every kind with the reason, and draws no profile chart', async () => {
    const { measure } = await world(scans, 'a');
    measure.loadMeasurements(ALL_KINDS());
    expect(measure.verticalUnitInvalid).toBe(true);
    for (const s of measure.getSummaries()) {
      expect(s.value).toBe(VERTICAL_SCALE_NOT_AVAILABLE);
      expect(s.value).not.toMatch(/\d m\b/);
      expect(s.profileChart).toBeUndefined();
      expect(profileCsvRefusal(s, false)).toMatch(/height unit could not be interpreted/);
    }
  });

  it('the trust grade refuses it too', () => {
    const strong = { snappedToPoint: true, pointsWithinRadius: 50 };
    expect(gradeMeasurement({ vertices: [strong, strong], crsKnown: true }).grade).toBe('green');
    const t = gradeMeasurement({ vertices: [strong, strong], crsKnown: true, verticalScaleInvalid: true });
    expect(t.reasons).toContain(`Value ${VERTICAL_SCALE_NOT_AVAILABLE}.`);
    expect(t.grade).toBe('red');
    expect(t.presentable).toBe(false);
    expect(t.caption).toMatch(/height unit could not be interpreted/);
  });

  it('the CSV never populates vertical_m, keeps only plan figures, and says why', async () => {
    const w = await world(scans, 'a');
    w.measure.loadMeasurements(ALL_KINDS());
    await exportMeasurementsFile('csv', w.deps());
    const rows = csvRows(w.files[0]!);
    for (const [id, row] of rows) {
      expect(row.vertical_m).toBe('');
      const populated = METRIC_COLUMNS.filter((k) => row[k] !== '');
      expect(populated.sort()).toEqual([...HORIZONTAL_KEPT[id]!].sort());
      expect(row.evidence).toContain(VERTICAL_SCALE_NOT_AVAILABLE);
    }
    expect(rows.get('h')!.horizontal_m).toBe('50');
    expect(rows.get('v')!.area_m2).toBe('100');
  });

  it('the GeoJSON writes no vertical figure and states the caveat', async () => {
    const w = await world(scans, 'a');
    w.measure.loadMeasurements(ALL_KINDS());
    await exportMeasurementsFile('geojson', w.deps());
    expect(w.refusals).toEqual([]);
    const fc = JSON.parse(w.files[0]!) as { features: Array<{ properties: Record<string, unknown> }>; evidence: string };
    for (const f of fc.features) {
      expect(f.properties.vertical_m ?? null).toBeNull();
      expect(f.properties.not_available).toBe(VERTICAL_SCALE_NOT_AVAILABLE);
    }
    expect(fc.evidence).toMatch(/Height unit could not be interpreted/);
  });

  it('the findings, the integrity report, the PDF rows and the KML agree', async () => {
    const w = await world(scans, 'a');
    const ms = ALL_KINDS();
    w.measure.loadMeasurements(ms);
    const findings = await collectMeasurementFindings(w.deps());
    expect(findings).toHaveLength(ms.length);
    for (const f of findings) {
      expect(f.value).toBeNull();
      expect(f.caveats).toContain(VERTICAL_SCALE_NOT_AVAILABLE);
    }
    await exportMeasurementIntegrityReport(w.deps());
    const report = JSON.parse(w.files[0]!) as { notes: string[]; findings: Array<{ value: number | null }> };
    expect(report.findings.every((f) => f.value === null)).toBe(true);
    expect(report.notes.join(' ')).toMatch(/Height unit could not be interpreted/);
    const rows = buildMeasurementRows(ms, 'metric', 1, [0, 0, 1], 1, true, false, false, true);
    expect(rows.every((r) => r.value === VERTICAL_SCALE_NOT_AVAILABLE)).toBe(true);
    const kml = buildKml({
      annotations: [], measurements: ms, viewpoints: [], crsName: 'x', unitLabel: 'm', up: [0, 0, 1], unitToMetres: 1,
      verticalUnitToMetres: INVALID.verticalUnitToMetres, verticalScaleInvalid: true, toLonLat: (p) => [p[0], p[1], p[2]], notSurveyGradeNote: 'n',
    });
    expect(kml).not.toMatch(/vertical_m=/);
    expect(kml).toContain(VERTICAL_SCALE_NOT_AVAILABLE);
    expect(kml).toMatch(/horizontal_m=50/);
  });

  it('a chain total is refused, and so is a lasso volume headline', () => {
    const r = aggregate(ALL_KINDS(), 'sum', 'height', [0, 0, 1], 1, 1, { verticalScaleInvalid: true });
    expect(r.refusal).toBe(VERTICAL_SCALE_NOT_AVAILABLE);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(volumeClaimRefusal(spatialContextFrom(INVALID), { canDisplayMetric: true, reason: '', suggestion: '' })).toMatch(/Height unit could not be interpreted/);
    expect(volumeClaimRefusal(spatialContextFrom(METRE), { canDisplayMetric: true, reason: '', suggestion: '' })).toBeNull();
  });

  it('an invalid factor set on the controller withholds; it does not ride the horizontal unit', async () => {
    const { measure } = await world([{ id: 'a', stable: 'layer-a', file: 'm.las', crs: METRE }], 'a');
    measure.setUnitResolver(null);
    measure.loadMeasurements([m('h', 'height', [[0, 0, 0], [0, 0, 100]])]);
    expect(measure.getSummaries()[0]!.value).toBe('100.00 m');
    measure.setVerticalUnitToMetres(Number.NaN);
    expect(measure.verticalUnitInvalid).toBe(true);
    expect(measure.getSummaries()[0]!.value).toBe(VERTICAL_SCALE_NOT_AVAILABLE);
    measure.setVerticalUnitToMetres(1);
    expect(measure.getSummaries()[0]!.value).toBe('100.00 m');
  });
});

describe('a valid vertical scale converts every mixed-axis figure by both factors', () => {
  it('yard heights: 100 source units is 91.44 m, and 3D figures mix 1 m grid with 0.9144 m heights', async () => {
    const w = await world([{ id: 'a', stable: 'layer-a', file: 'yard.las', crs: YARD }], 'a');
    w.measure.loadMeasurements(ALL_KINDS());
    const live = new Map(w.measure.getSummaries().map((s) => [s.id, s.value]));
    expect(live.get('h')).toBe('91.440 m');
    await exportMeasurementsFile('csv', w.deps());
    const rows = csvRows(w.files[0]!);
    const v = 91.44;
    expect(Number(rows.get('h')!.vertical_m)).toBeCloseTo(v, 3);
    expect(Number(rows.get('h')!.horizontal_m)).toBeCloseTo(50, 3);
    expect(Number(rows.get('d')!.length_m)).toBeCloseTo(Math.hypot(50, v), 3);
    expect(Number(rows.get('s')!.grade_pct)).toBeCloseTo((v / 50) * 100, 3);
    expect(Number(rows.get('r')!.vertical_m)).toBeCloseTo(v, 3);
    // Tilted 10 × 10 ring rising 10 units: plan 10 × 10 m, slope run 10 m over 9.144 m.
    expect(Number(rows.get('a')!.area_m2)).toBeCloseTo(10 * Math.hypot(10, 9.144), 3);
    expect(Number(rows.get('b')!.height_m)).toBeCloseTo(5 * 0.9144, 3);
    expect(Number(rows.get('v')!.fill_m3)).toBeCloseTo(5 * 0.9144, 3);
    expect(rows.get('h')!.evidence).not.toContain('not available');
  });
});

describe('another layer\'s frame never authorises a height', () => {
  const A = { id: 'a', stable: 'layer-a', file: 'metre.las', crs: METRE };
  const B = { id: 'b', stable: 'layer-b', file: 'invalid.las', crs: INVALID };

  it('a height taken on the invalid layer is withheld while the valid layer is active', async () => {
    const w = await world([A, B], 'a');
    w.measure.loadMeasurements([m('onA', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-a'), m('onB', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-b')]);
    const live = new Map(w.measure.getSummaries().map((s) => [s.id, s.value]));
    expect(live.get('onA')).toBe('100.00 m');
    expect(live.get('onB')).toBe(VERTICAL_SCALE_NOT_AVAILABLE);
    w.measure.loadMeasurements([m('onB', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-b')]);
    await exportMeasurementsFile('csv', w.deps());
    expect(csvRows(w.files[0]!).get('onB')!.vertical_m).toBe('');
  });

  it('a height taken on the valid layer reads while the invalid layer is active', async () => {
    const w = await world([A, B], 'b');
    w.measure.loadMeasurements([m('onA', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-a')]);
    expect(w.measure.getSummaries()[0]!.value).toBe('100.00 m');
    await exportMeasurementsFile('csv', w.deps());
    expect(csvRows(w.files[0]!).get('onA')!.vertical_m).toBe('100');
  });

  it('a measurement spanning both layers is not given either frame', async () => {
    const w = await world([A, B], 'a');
    w.measure.loadMeasurements([m('both', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-a', { pickLayers: ['layer-a', 'layer-b'] })]);
    // Neither layer's metre scale applies, so the figure is the stored 100 units, labelled as such.
    expect(w.measure.getSummaries()[0]!.value).toBe('100 (unit unverified)');
  });
});

describe('the validity state survives a delayed export and a saved session', () => {
  it('a vertical unit change while the serializer loads does not reach the file', async () => {
    const w = await world([{ id: 'a', stable: 'layer-a', file: 'invalid.las', crs: INVALID }], 'a');
    w.measure.setUnitResolver(null);
    // No layer list: the snapshot of the live controller is the only frame.
    w.measure.loadMeasurements([m('h', 'height', [[0, 0, 0], [0, 0, 100]], 'layer-a', { pickLayers: [], owner: undefined })]);
    const base = w.deps({ layers: undefined, frameSource: undefined });
    await exportMeasurementsFile('csv', {
      ...base,
      loadMeasurementExport: async () => {
        w.measure.setVerticalUnitToMetres(1);
        return base.loadMeasurementExport();
      },
    });
    expect(csvRows(w.files[0]!).get('h')!.vertical_m).toBe('');
  });

  it('a session saved with an invalid vertical unit reopens withholding the height', async () => {
    const reloaded = parseResolvedCrs(JSON.parse(JSON.stringify(resolvedFromCrsInfo(INVALID, 'las-vlr'))))!;
    const ctx = spatialContextFrom(reloaded);
    expect(ctx.verticalScaleState).toBe('invalid');
    expect(measureUnitFrameOf(ctx).verticalUnitInvalid).toBe(true);
    expect(frameScalars(ctx).verticalScaleInvalid).toBe(true);
  });
});
