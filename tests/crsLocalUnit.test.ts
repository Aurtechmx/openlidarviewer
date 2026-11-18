/**
 * The user declares the unit of local coordinates in the CRS picker.
 *
 * A local frame with no declared unit withholds every metric figure, and most
 * phone scans say nothing about their unit. The picker now offers local
 * coordinates in metres, US survey feet or international feet beside the
 * plain "Local coordinates (no CRS)". The choice is stored with the override
 * (a stored unit the reader does not know is dropped, so the frame withholds),
 * resolves to that unit and factor, and every consumer that reads the spatial
 * context converts by it. Coordinates are not rescaled.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderCrs, type CrsOverride as PickerOverride } from '../src/ui/inspector/renderCrs';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import {
  _resetSuppressionLatchForTesting,
  getOverride,
  setOverride as storeOverride,
  snapshotOverrides,
  type CrsOverride,
} from '../src/geo/CrsOverrideStore';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import { resolvedHorizontalUnitToMetres, volumeClaimRefusal } from '../src/geo/SpatialContext';
import { measureUnitFrameOf } from '../src/app/measurementExportFrame';
import { profileMetresPerUnit } from '../src/app/measurePanelMount';
import { cursorReadout } from '../src/geo/cursorReadout';
import { FakeEl } from './support/measurePanelDom';
import { installInspectorFakeDom } from './helpers/inspectorLazyHarness';

const FT_US = 1200 / 3937;

function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** A scan with no CRS, then the local choice the picker sends. */
function pickLocal(localUnit?: 'metre' | 'us-survey-foot' | 'foot') {
  const port = memoryPort();
  const svc = new CrsService(port);
  svc.resolveForScan({ name: 'phone.ply', detected: undefined, source: 'las-vlr' });
  svc.setOverride({ override: { epsg: null, kind: 'local', ...(localUnit ? { localUnit } : {}) }, detected: undefined, source: 'las-vlr' });
  return { svc, port };
}

const localOverride = (linearUnit: ResolvedCrs['linearUnit'], name: string): ResolvedCrs => ({
  kind: 'local', name, linearUnit, linearUnitToMetres: linearUnit === 'metre' ? 1 : linearUnit === 'foot' ? 0.3048 : linearUnit === 'us-survey-foot' ? FT_US : 1,
  source: 'user-override', confidence: 'high', userConfirmed: true,
});

describe('the picker', () => {
  beforeAll(() => installInspectorFakeDom());

  function render(c: ResolvedCrs, sent: PickerOverride[] = []): FakeEl {
    const body = new FakeEl('div');
    renderCrs(body as unknown as HTMLElement, c, (o) => sent.push(o));
    return body.children.find((k) => k.tagName === 'select')!;
  }
  const options = (select: FakeEl) => select.children.filter((k) => k.tagName === 'option');

  it('offers the three local units right after "Local coordinates (no CRS)"', () => {
    const select = render(localOverride('unknown', 'Local coordinates (no CRS)'));
    expect(options(select).map((o) => [o.value, o.textContent])).toEqual([
      ['__detected__', 'Reset to detected'],
      ['__local__', 'Local coordinates (no CRS)'],
      ['__local_m__', 'Local coordinates in metres (no CRS)'],
      ['__local_ussft__', 'Local coordinates in US survey feet (no CRS)'],
      ['__local_ft__', 'Local coordinates in international feet (no CRS)'],
    ]);
  });

  it.each([
    ['unknown', '__local__'],
    ['metre', '__local_m__'],
    ['us-survey-foot', '__local_ussft__'],
    ['foot', '__local_ft__'],
  ] as const)('preselects the active local choice (%s)', (unit, value) => {
    const select = render(localOverride(unit, 'x'));
    const selected = options(select).filter((o) => (o as unknown as { selected?: boolean }).selected === true);
    expect(selected.map((o) => o.value)).toEqual([value]);
  });

  it('preselects no local option for a file\'s own local frame', () => {
    const select = render({ ...localOverride('metre', 'Site grid'), source: 'las-vlr', userConfirmed: false });
    expect(options(select).some((o) => (o as unknown as { selected?: boolean }).selected === true)).toBe(false);
  });

  it.each([
    ['__local__', undefined],
    ['__local_m__', 'metre'],
    ['__local_ussft__', 'us-survey-foot'],
    ['__local_ft__', 'foot'],
  ] as const)('%s sends a local override with that unit', (value, localUnit) => {
    const sent: PickerOverride[] = [];
    const select = render(localOverride('unknown', 'x'), sent);
    select.value = value;
    select.dispatchEvent({ type: 'change' });
    expect(sent).toEqual([localUnit ? { epsg: null, kind: 'local', localUnit } : { epsg: null, kind: 'local' }]);
  });
});

describe('the override store keeps the unit, and drops one it does not know', () => {
  const saved = (globalThis as Record<string, unknown>).window;
  beforeAll(() => {
    const data = new Map<string, string>();
    (globalThis as Record<string, unknown>).window = {
      location: { search: '' },
      localStorage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
        removeItem: (k: string) => { data.delete(k); },
      },
    };
  });
  afterAll(() => { (globalThis as Record<string, unknown>).window = saved; });
  beforeEach(() => _resetSuppressionLatchForTesting());

  it.each(['metre', 'us-survey-foot', 'foot'] as const)('round trip with %s', (localUnit) => {
    storeOverride(`scan-${localUnit}`, { epsg: null, kind: 'local', localUnit });
    expect(getOverride(`scan-${localUnit}`)?.localUnit).toBe(localUnit);
  });

  it('an invalid stored unit reads as no unit', () => {
    storeOverride('bad', { epsg: null, kind: 'local', localUnit: 'chain' as never });
    const back = getOverride('bad')!;
    expect(back.kind).toBe('local');
    expect('localUnit' in back).toBe(false);
    expect(snapshotOverrides().find((o) => o.datasetKey === 'bad')!.localUnit).toBeUndefined();
  });

  it('a unit on a projected record is dropped', () => {
    storeOverride('proj', { epsg: 32612, kind: 'projected', localUnit: 'foot' });
    expect(getOverride('proj')!.localUnit).toBeUndefined();
  });

  it('an old local record without the field has no unit', () => {
    storeOverride('old', { epsg: null, kind: 'local' });
    expect(getOverride('old')!.localUnit).toBeUndefined();
  });
});

describe('the service resolves the local unit', () => {
  it.each([
    ['metre', 'Local coordinates in metres (no CRS)', 1],
    ['us-survey-foot', 'Local coordinates in US survey feet (no CRS)', FT_US],
    ['foot', 'Local coordinates in international feet (no CRS)', 0.3048],
  ] as const)('%s', (unit, name, factor) => {
    const { svc, port } = pickLocal(unit);
    const crs = svc.current()!;
    expect(crs.kind).toBe('local');
    expect(crs.name).toBe(name);
    expect(crs.linearUnit).toBe(unit);
    expect(crs.linearUnitToMetres).toBe(factor);
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(true);
    expect(validateCrsForMeasurement(crs).canDisplayMetric).toBe(true);
    expect([...port.entries.values()][0]!.localUnit).toBe(unit);
  });

  it('no unit stays withheld', () => {
    const crs = pickLocal().svc.current()!;
    expect(crs.name).toBe('Local coordinates (no CRS)');
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitToMetres).toBe(1);
  });

  it('a unit the service does not know is ignored', () => {
    const crs = pickLocal('chain' as never).svc.current()!;
    expect(crs.linearUnit).toBe('unknown');
  });

  it('"Use detected" still clears', () => {
    const { svc, port } = pickLocal('metre');
    svc.setOverride({ override: { epsg: null, kind: 'detected' }, detected: undefined, source: 'las-vlr' });
    expect(port.entries.size).toBe(0);
    expect(svc.current()!.kind).toBe('unknown');
  });
});

describe('consumers convert a local frame by its declared unit', () => {
  it('a local frame in US survey feet', () => {
    const ctx = pickLocal('us-survey-foot').svc.context();
    expect(ctx.linearUnitToMetres).toBe(FT_US);
    expect(measureUnitFrameOf(ctx).unitToMetres).toBe(FT_US);
    expect(measureUnitFrameOf(ctx).crsKnown).toBe(true);
    expect(profileMetresPerUnit(ctx)).toBe(FT_US);
    expect(resolvedHorizontalUnitToMetres(ctx, null)).toBe(FT_US);
    const readout = cursorReadout({ crs: { active: pickLocal('us-survey-foot').svc.current()! }, upAxis: 'z' });
    expect(readout.unit.metresPerUnit).toBe(FT_US);
  });

  it('a lasso volume states m³ on a local-metres frame and not on a no-unit one', () => {
    const metres = pickLocal('metre').svc;
    expect(volumeClaimRefusal(metres.context(), metres.validation())).toBeNull();
    expect(metres.validation().canSaveMeasurement).toBe(true);
    const none = pickLocal().svc;
    expect(volumeClaimRefusal(none.context(), none.validation())).not.toBeNull();
    expect(none.validation().canSaveMeasurement).toBe(false);
  });
});
