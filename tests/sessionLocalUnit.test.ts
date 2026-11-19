/**
 * A session whose CRS is the user's local choice with a declared unit
 * restores with that unit.
 *
 * The session file records the resolved CRS, so a local frame in metres is
 * written with `linearUnit: 'metre'`. The restore applied every local choice
 * as plain "Local coordinates (no CRS)", so the unit was lost and every metric
 * figure withheld. A named unit whose factor matches it now restores; a local
 * frame without a unit, or with a factor that does not match its unit, stays
 * without one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { restoreSession } from './helpers/sessionRestoreHarness';
import type { CrsInfo } from '../src/io/crs';
import { formatSpecificationCrs } from '../src/geo/CoordinateTypes';
import { crsFromWkt } from '../src/io/crs';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => ({}) };
});

const FT_US = 1200 / 3937;

/** The CRS a session records for the user's local choice. */
function local(linearUnit: ResolvedCrs['linearUnit'], linearUnitToMetres: number, name = 'Local coordinates (no CRS)'): ResolvedCrs {
  return { kind: 'local', name, linearUnit, linearUnitToMetres, source: 'user-override', confidence: 'high', userConfirmed: true };
}

/** Restore a session carrying `crs` onto a streamed scan that declares `declared`. */
const restore = (declared: CrsInfo | null, crs: ResolvedCrs, sourcePoints = 1000, opts: { skipScanConfirm?: boolean } = {}, withCurrent = false) =>
  restoreSession(declared, crs, { sourcePoints, ...opts, withCurrent });


const SET = /This session set the coordinate system to/;

describe('a local session CRS with a declared unit', () => {
  it.each([
    ['metre', 1, 'Local coordinates in metres (no CRS)'],
    ['us-survey-foot', FT_US, 'Local coordinates in US survey feet (no CRS)'],
    ['foot', 0.3048, 'Local coordinates in international feet (no CRS)'],
  ] as const)('restores in %s', async (unit, factor, name) => {
    const r = await restore(null, local(unit, factor, name));
    expect(r.ok).toBe(true);
    expect(r.setCrsOverride.mock.calls[0][0].override).toEqual({ epsg: null, kind: 'local', localUnit: unit });
    const crs = r.crsService.current()!;
    expect(crs.kind).toBe('local');
    expect(crs.linearUnit).toBe(unit);
    expect(crs.linearUnitToMetres).toBe(factor);
    expect(r.crsService.context().metricClaimsPermitted).toBe(true);
    const i = r.toasts.findIndex((t) => SET.test(t));
    expect(r.toasts[i]).toContain(`This session set the coordinate system to ${name}. It applies to this scan for now and is not saved on this device.`);
    r.actions[i]!.onClick();
    expect([...r.store.values()][0]).toMatchObject({ kind: 'local', localUnit: unit });
  });
});

describe('a local session CRS without a usable unit stays without one', () => {
  it('no unit', async () => {
    const r = await restore(null, local('unknown', 1));
    expect(r.setCrsOverride.mock.calls[0][0].override).toEqual({ epsg: null, kind: 'local' });
    expect(r.crsService.current()!.linearUnit).toBe('unknown');
    expect(r.crsService.context().metricClaimsPermitted).toBe(false);
  });

  it('a unit whose factor does not match it, and the toast says why', async () => {
    const r = await restore(null, local('us-survey-foot', 0.3048));
    expect(r.setCrsOverride.mock.calls[0][0].override).toEqual({ epsg: null, kind: 'local' });
    expect(r.crsService.current()!.linearUnit).toBe('unknown');
    expect(r.toasts.some((t) => t.includes('This session\'s unit for local coordinates, US survey feet, was not restored because the factor saved with it (0.3048 m per unit) does not match that unit, so metric figures stay withheld.'))).toBe(true);
  });

  it('metres saved with a foot factor', async () => {
    const r = await restore(null, local('metre', 0.3048));
    expect(r.ok).toBe(true);
    expect(r.crsService.current()!.linearUnit).toBe('unknown');
    expect(r.crsService.context().metricClaimsPermitted).toBe(false);
    const i = r.toasts.findIndex((t) => t.includes('was not restored because the factor saved with it'));
    expect(r.toasts[i]).toContain('Session restored');
    expect(r.toasts[i]).toContain('This session\'s unit for local coordinates, metres, was not restored because the factor saved with it (0.3048 m per unit) does not match that unit, so metric figures stay withheld.');
    // Nothing to keep: no unit was applied.
    expect(r.actions[i]).toBeUndefined();
  });

  it('no clause when the session declares no unit', async () => {
    const r = await restore(null, local('unknown', 1));
    expect(r.toasts.some((t) => t.includes('was not restored because the factor'))).toBe(false);
  });
});

describe('a GLB states no unit a session could contradict', () => {
  // The metres a format specification gives are the app's reading of a file
  // that states nothing, so a session in feet is not a unit conflict with it.
  it.each([
    ['local feet', local('foot', 0.3048, 'Local coordinates in international feet (no CRS)'), 'foot'],
    ['EPSG:2229', { kind: 'projected', name: 'NAD83 / California zone 5 (ftUS)', epsg: 2229, linearUnit: 'us-survey-foot', linearUnitToMetres: FT_US, source: 'user-override', confidence: 'high', userConfirmed: true } as ResolvedCrs, 'us-survey-foot'],
  ] as const)('%s on a partial match restores after Apply anyway', async (_label, crs, unit) => {
    const r = await restore(formatSpecificationCrs('glTF'), crs, 1010, { skipScanConfirm: true });
    expect(r.ok).toBe(true);
    expect(r.toasts.some((t) => /conflicts with this scan/.test(t))).toBe(false);
    expect(r.crsService.current()!.linearUnit).toBe(unit);
  });
});

describe('the notice follows the CRS that was active before the restore', () => {
  const UTM = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';
  const projected = (epsg: number, name: string): ResolvedCrs =>
    ({ kind: 'projected', name, epsg, linearUnit: 'metre', linearUnitToMetres: 1, source: 'user-override', confidence: 'high', userConfirmed: true });
  const notice = (toasts: readonly string[]) => toasts.find((t) => SET.test(t));

  describe.each([[false, 'the declaration standing in'], [true, 'crsService.current()']] as const)('with %s (%s)', (withCurrent, _basis) => {
    it('a plain local session on a GLB says the unit went away', async () => {
      const r = await restore(formatSpecificationCrs('glTF'), local('unknown', 1), 1000, {}, withCurrent);
      expect(r.crsService.current()!.linearUnit).toBe('unknown');
      expect(notice(r.toasts)).toContain('This session set the coordinate system to Local coordinates (no CRS) (no EPSG code; linear unit not declared).');
    });

    it('a local metres session on a GLB changes nothing and stays quiet', async () => {
      const r = await restore(formatSpecificationCrs('glTF'), local('metre', 1, 'Local coordinates in metres (no CRS)'), 1000, {}, withCurrent);
      expect(r.crsService.current()!.linearUnit).toBe('metre');
      expect(notice(r.toasts)).toBeUndefined();
    });

    it('a LAS file: the same CRS stays quiet, another CRS is named', async () => {
      const same = await restore(crsFromWkt(UTM), projected(32612, 'WGS 84 / UTM zone 12N'), 1000, {}, withCurrent);
      expect(notice(same.toasts)).toBeUndefined();
      const other = await restore(crsFromWkt(UTM), projected(32613, 'WGS 84 / UTM zone 13N'), 1000, {}, withCurrent);
      expect(notice(other.toasts)).toContain('This session set the coordinate system to WGS 84 / UTM zone 13N [EPSG:32613] (metres).');
    });
  });
});
