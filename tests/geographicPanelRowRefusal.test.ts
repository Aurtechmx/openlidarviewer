/**
 * On a geographic (degree) CRS the Measurements panel row and its breakdown
 * make the same refusal as the overlay labels and every export: a length,
 * grade or area mixing degree X/Y with a linear Z prints the reason, never a
 * number in metres. A pure-vertical height is still shown.
 *
 * The CRS layer supplies an inert horizontal factor of 1 for degrees, so a
 * figure that slipped through would read degrees as metres.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import { measureUnitFrameOf } from '../src/app/measurementExportFrame';
import { CrsService } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const wgs84: CrsInfo = { source: 'wkt', name: 'WGS 84', epsg: 4326, linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: true, verticalUnitToMetres: 1 } as CrsInfo;

function mk(kind: MeasurementKind, points: Vec3[]): Measurement {
  return { id: kind, kind, name: kind, closed: kind === 'area', points } as Measurement;
}

async function controllerFor(crs: CrsInfo) {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
  svc.resolveForScan({ name: 'g.las', detected: crs, source: 'las-vlr' });
  // Fed exactly as the app feeds the active scan.
  const f = measureUnitFrameOf(svc.context());
  measure.setUnitToMetres(f.unitToMetres);
  measure.setVerticalUnitToMetres(f.verticalUnitToMetres ?? 1);
  measure.setVerticalUnitKnown(f.verticalUnitKnown);
  measure.setCrsKnown(f.crsKnown);
  measure.setGeographicCrs(f.geographic, f.verticalRefused);
  measure.setProjectedCrs(f.projected);
  return { measure, frame: f };
}

const METRIC_FIGURE = /\d\s*(mm|cm|m|km|m²|ha|km²|m³|ft|mi)\b|%/;

describe('Measurements panel on a geographic CRS', () => {
  it('the CRS layer supplies an inert factor of 1 for degrees and flags the frame geographic', async () => {
    const { frame } = await controllerFor(wgs84);
    expect(frame.geographic).toBe(true);
    expect(frame.unitToMetres).toBe(1);
  });

  it.each([
    ['distance', [[-105, 40, 0], [-104.999, 40, 10]]],
    ['polyline', [[-105, 40, 0], [-104.999, 40, 0], [-104.999, 40.001, 0]]],
    ['slope', [[-105, 40, 0], [-104.999, 40, 10]]],
    ['area', [[-105, 40, 0], [-104.999, 40, 0], [-104.999, 40.001, 0]]],
    ['profile', [[-105, 40, 0], [-104.999, 40, 10]]],
    ['angle', [[-104.999, 40, 0], [-105, 40, 0], [-105, 40, 10]]],
  ] as Array<[MeasurementKind, Vec3[]]>)('a %s row prints the refusal, not a metric figure', async (kind, pts) => {
    const { measure } = await controllerFor(wgs84);
    measure.loadMeasurements([mk(kind, pts)]);
    const s = measure.getSummaries()[0];
    expect(s.value).toBe(GEOGRAPHIC_NOT_AVAILABLE);
    expect(s.value).not.toMatch(METRIC_FIGURE);
    expect(s.lineMetrics).toBeUndefined();
    expect(s.areaMetrics).toBeUndefined();
  });

  it('a height keeps its vertical figure', async () => {
    const { measure } = await controllerFor(wgs84);
    measure.loadMeasurements([mk('height', [[-105, 40, 0], [-104.999, 40.001, 40]])]);
    const s = measure.getSummaries()[0];
    expect(s.value).not.toBe(GEOGRAPHIC_NOT_AVAILABLE);
    expect(s.value).toMatch(/^40\.0+ m$/);
  });

  it('a projected metre CRS still shows the length and its breakdown', async () => {
    const utm: CrsInfo = { source: 'wkt', name: 'WGS 84 / UTM zone 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as CrsInfo;
    const { measure } = await controllerFor(utm);
    measure.loadMeasurements([mk('distance', [[0, 0, 0], [3, 0, 4]])]);
    const s = measure.getSummaries()[0];
    expect(s.value).toMatch(/^5\.0+ m/);
    expect(s.lineMetrics).toBeDefined();
  });
});
