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
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { importSession, type SessionIoDeps, type SessionModule } from '../src/app/sessionIo';
import {
  detectSessionSpatialConflict,
  matchSessionToScan,
  parseSession,
  rebaseSessionGeometry,
  serializeSession,
} from '../src/io/session';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import { formatSpecificationCrs } from '../src/geo/CoordinateTypes';
import { crsFromWkt } from '../src/io/crs';
import type { Viewer } from '../src/render/Viewer';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => ({}) };
});

const FT_US = 1200 / 3937;

/** The CRS a session records for the user's local choice. */
function local(linearUnit: ResolvedCrs['linearUnit'], linearUnitToMetres: number, name = 'Local coordinates (no CRS)'): ResolvedCrs {
  return { kind: 'local', name, linearUnit, linearUnitToMetres, source: 'user-override', confidence: 'high', userConfirmed: true };
}

const sessionModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict };
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

/** Restore a session carrying `crs` onto a streamed scan that declares `declared`. */
async function restore(declared: CrsInfo | null, crs: ResolvedCrs, sourcePoints = 1000, opts: { skipScanConfirm?: boolean } = {}, withCurrent = false) {
  const store = new Map<string, unknown>();
  const crsService = new CrsService({
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => void store.delete(k),
  } as CrsOverridePort);
  crsService.resolveForScan({ name: 'loaded.laz', detected: declared ?? undefined, source: 'las-vlr' });
  const loadMeasurements = vi.fn();
  const setCrsOverride = vi.fn((args: Parameters<CrsService['setOverride']>[0]) => crsService.setOverride(args));
  const showToast = vi.fn();
  const viewer = {
    clouds: () => [] as string[],
    hasStreamingCloud: true,
    streamingCloud: {
      name: 'loaded.laz',
      sourcePointCount: 1000,
      dataBounds: () => [0, 0, 0, 10, 10, 3],
      crs: () => declared,
    },
    getCloud: () => undefined,
    measure: { loadMeasurements, getMeasurements: () => [] },
    annotate: { loadAnnotations: vi.fn(), getAnnotations: () => [] },
  };
  const deps: SessionIoDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    loadSession: async () => sessionModule,
    appVersion: '0.6.3',
    getActiveScanId: () => null,
    getActiveLayerId: () => null,
    getActiveCloud: () => null,
    exportOrigin: () => [0, 0, 0],
    bookmarks: { restore: vi.fn(), names: () => ['V1'] },
    setInspectorViews: vi.fn(),
    restoreLayerGroups: vi.fn(),
    refreshMeasurePanel: vi.fn(),
    refreshAnnotationPanel: vi.fn(),
    applyViewState: vi.fn(),
    setCrsOverride,
    ...(withCurrent ? { currentCrs: () => crsService.current() } : {}),
    showToast,
    setDropError: vi.fn(),
  };
  const file = asFile(serializeSession({
    upAxis: 'z',
    origin: [0, 0, 0],
    unitSystem: 'metric',
    views: [{ name: 'V1', camera: { position: [1, 2, 3], target: [4, 5, 6], mode: 'orbit' } }],
    measurements: [{ id: 'a', kind: 'distance', name: 'D1', points: [[0, 0, 0], [1, 0, 0]] }],
    annotations: [],
    software: '0.6.3',
    crs,
    scanSummary: { fileName: 'loaded.laz', sourcePoints, width: 10, depth: 10, height: 3 },
  } as never));
  const ok = await importSession(file, opts, deps);
  const toasts = showToast.mock.calls.map((c) => c[0] as string);
  const actions = showToast.mock.calls.map((c) => c[1] as { label: string; onClick: () => void } | undefined);
  return { ok, crsService, store, setCrsOverride, loadMeasurements, toasts, actions };
}


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
