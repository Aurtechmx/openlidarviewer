/**
 * A height on a geographic (degree) CRS that declares no vertical unit has no
 * known unit: the horizontal factor is an inert 1 for degrees, so the height
 * cannot be called metres. It reads in source units marked unverified, the
 * confidence line says the unit is unverified, and the trust reason names the
 * missing vertical unit rather than a missing CRS. With a declared vertical
 * unit the height is metres as before.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { UNIT_UNVERIFIED } from '../src/render/measure/format';
import { gradeMeasurement } from '../src/render/measure/measurementTrust';
import { buildMeasureConfidenceContext } from '../src/app/measureConfidenceContext';
import { measureUnitFrameOf } from '../src/app/measurementExportFrame';
import { CrsService } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const nad83: CrsInfo = { source: 'wkt', name: 'NAD83', epsg: 4269, linearUnit: 'unknown', linearUnitToMetres: 1, isGeographic: true } as CrsInfo;
const nad83Navd88: CrsInfo = { ...nad83, verticalUnitToMetres: 1 } as CrsInfo;

function ctxOf(crs: CrsInfo) {
  const svc = new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
  svc.resolveForScan({ name: 'g.las', detected: crs, source: 'las-vlr' });
  return svc.context();
}

const height: Measurement = { id: 'h', kind: 'height', name: 'h', closed: false, points: [[0, 0, 0], [0.001, 0.001, 40]] } as Measurement;

async function headline(crs: CrsInfo): Promise<{ value: string; unitUnverified?: boolean; label: string }> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  // Fed exactly as the app feeds the active scan.
  const f = measureUnitFrameOf(ctxOf(crs));
  measure.setUnitToMetres(f.unitToMetres);
  measure.setVerticalUnitToMetres(f.verticalUnitToMetres ?? 1);
  measure.setCrsKnown(f.crsKnown);
  measure.setGeographicCrs(f.geographic, f.verticalRefused);
  (measure as unknown as { setVerticalUnitKnown?: (k: boolean) => void }).setVerticalUnitKnown?.(f.verticalUnitKnown);
  measure.loadMeasurements([structuredClone(height)]);
  const [s] = measure.getSummaries();
  const label = (measure as unknown as { _buildModel(): { labels: { text: string; primary: boolean }[] } })
    ._buildModel().labels.find((l) => l.primary)!.text;
  return { value: s!.value, unitUnverified: s!.unitUnverified, label };
}

describe('height on a geographic CRS', () => {
  it('with no vertical unit reads in source units, marked unverified', async () => {
    const r = await headline(nad83);
    expect(r.value).toContain(UNIT_UNVERIFIED);
    expect(r.value).not.toMatch(/ m\b/);
    expect(r.unitUnverified).toBe(true);
    expect(r.label).toBe(r.value);
  });

  it('with a declared vertical unit reads metres', async () => {
    const r = await headline(nad83Navd88);
    expect(r.value).toMatch(/^40\.0+ m$/);
    expect(r.unitUnverified).toBeFalsy();
  });

  it('the confidence context calls the unit unverified only when no vertical unit is declared', () => {
    const v = (geographicCrs: boolean) => ({ measure: { datumResolved: true, crsKnown: false, geographicCrs }, clouds: () => [null] });
    expect(buildMeasureConfidenceContext(v(true), null, ctxOf(nad83)).unitVerified).toBe(false);
    expect(buildMeasureConfidenceContext(v(true), null, ctxOf(nad83Navd88)).unitVerified).toBe(true);
  });

  it('the trust reason names the missing vertical unit, not a missing CRS', () => {
    const strong = [{ snappedToPoint: true, pointsWithinRadius: 50 }, { snappedToPoint: true, pointsWithinRadius: 50 }];
    const t = gradeMeasurement({ vertices: strong, crsKnown: false, frameGeographic: true, verticalUnitKnown: false } as Parameters<typeof gradeMeasurement>[0]);
    expect(t.reasons.join(' ')).not.toMatch(/No CRS/);
    expect(t.reasons.join(' ')).toMatch(/no declared vertical unit/);
    expect(t.grade).toBe('yellow');
    const known = gradeMeasurement({ vertices: strong, crsKnown: false, frameGeographic: true, verticalUnitKnown: true } as Parameters<typeof gradeMeasurement>[0]);
    expect(known.reasons.join(' ')).not.toMatch(/No CRS|vertical unit/);
    expect(known.grade).toBe('green');
  });
});
