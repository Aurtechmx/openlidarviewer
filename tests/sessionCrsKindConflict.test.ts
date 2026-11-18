/**
 * A session CRS of another kind than the scan's own declared CRS refuses the
 * CRS, never the work.
 *
 * A session saying "projected EPSG:4978" over a geocentric 4978 file, or
 * "projected EPSG:4326" over a geographic 4326 file, was restored as the
 * author's override and a geocentric scan lost its elevation-workflow refusal.
 * The scan now keeps its CRS, the session's measurements, annotations and
 * views restore under it, and the notice names both CRSs with an action that
 * applies the session's CRS the way an Inspector pick does. A CRS the session
 * file merely records (not the user's confirmed choice) is never applied and
 * raises no kind conflict. A session that agrees with the file still applies
 * quietly, and a file whose own GeoKeys contradict their code can still be
 * corrected by a session that names the code's kind.
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
import { elevationWorkflowRefusal } from '../src/geo/SpatialContext';
import { crsFromGeoTiff, crsFromWkt, type CrsInfo } from '../src/io/crs';
import type { Viewer } from '../src/render/Viewer';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = { createElement: () => ({}) };
});

const GEOCENTRIC = 'GEOCCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["metre",1],AXIS["Geocentric X",OTHER],AXIS["Geocentric Y",OTHER],AXIS["Geocentric Z",NORTH],AUTHORITY["EPSG","4978"]]';
const WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';
const UTM = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]';

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

const sessionModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict };
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

/** The CRS a session records when its author picked `epsg` as `kind` (or, with `fromFile`, the file's own). */
function sessionCrs(epsg: number, kind: 'projected' | 'geographic', fromFile = false): ResolvedCrs {
  return {
    kind,
    name: `EPSG:${epsg}`,
    epsg,
    linearUnit: kind === 'projected' ? 'metre' : 'unknown',
    linearUnitToMetres: 1,
    source: fromFile ? 'las-vlr' : 'user-override',
    confidence: 'high',
    userConfirmed: !fromFile,
  };
}

/** Restore a session carrying `crs` onto a streamed scan that declares `declared`. */
async function restore(declared: CrsInfo, crs: ResolvedCrs) {
  const store = new Map<string, unknown>();
  const crsService = new CrsService({
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => void store.delete(k),
  } as CrsOverridePort);
  crsService.resolveForScan({ name: 'loaded.laz', detected: declared, source: 'las-vlr' });
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
    scanSummary: { fileName: 'loaded.laz', sourcePoints: 1000, width: 10, depth: 10, height: 3 },
  } as never));
  const ok = await importSession(file, {}, deps);
  const toasts = showToast.mock.calls.map((c) => c[0] as string);
  const actions = showToast.mock.calls.map((c) => c[1] as { label: string; onClick: () => void } | undefined);
  return { ok, crsService, store, setCrsOverride, loadMeasurements, toasts, actions };
}

const KIND_NOTICE = /was not applied/;
const REFUSAL = /conflicts with this scan/;

describe('a user CRS of another kind restores the work under the scan\'s CRS', () => {
  it('a geographic 4326 file with a projected 32612 session', async () => {
    const r = await restore(crsFromWkt(WGS84), sessionCrs(32612, 'projected'));
    expect(r.ok).toBe(true);
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    // The stored geometry is handed over as saved: figures are computed from
    // it under the active CRS, which is the scan's.
    expect(r.loadMeasurements.mock.calls[0][0][0].points).toEqual([[0, 0, 0], [1, 0, 0]]);
    expect(r.setCrsOverride).not.toHaveBeenCalled();
    expect(r.crsService.current()!.kind).toBe('geographic');
    expect(r.crsService.current()!.epsg).toBe(4326);
    expect(r.toasts.some((t) => REFUSAL.test(t))).toBe(false);
    const i = r.toasts.findIndex((t) => KIND_NOTICE.test(t));
    expect(r.toasts[i]).toContain('This session\'s coordinate system, EPSG:32612 (projected), was not applied because the scan declares a geographic one, WGS 84 (EPSG:4326), which stays in use.');
    expect(r.toasts[i]).not.toContain('load the session on its own scan');
    expect(r.actions[i]?.label).toBe('Use session CRS');
    r.actions[i]!.onClick();
    expect(r.setCrsOverride).toHaveBeenCalledTimes(1);
    expect(r.setCrsOverride.mock.calls[0][0].persist).toBe(true);
    expect(r.crsService.current()!.kind).toBe('projected');
    expect(r.crsService.current()!.epsg).toBe(32612);
    expect(r.store.size).toBe(1);
  });

  it('a projected 32612 file with a geographic 4326 session', async () => {
    const r = await restore(crsFromWkt(UTM), sessionCrs(4326, 'geographic'));
    expect(r.ok).toBe(true);
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.crsService.current()!.kind).toBe('projected');
    expect(r.crsService.current()!.epsg).toBe(32612);
    const i = r.toasts.findIndex((t) => KIND_NOTICE.test(t));
    expect(r.toasts[i]).toContain('This session\'s coordinate system, EPSG:4326 (geographic), was not applied because the scan declares a projected one, WGS 84 / UTM zone 12N (EPSG:32612), which stays in use.');
    r.actions[i]!.onClick();
    expect(r.crsService.current()!.kind).toBe('geographic');
    expect(r.crsService.current()!.epsg).toBe(4326);
  });

  it('a geocentric 4978 file keeps its CRS and its elevation refusal under a projected 4978 session', async () => {
    const r = await restore(crsFromWkt(GEOCENTRIC), sessionCrs(4978, 'projected'));
    expect(r.ok).toBe(true);
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.setCrsOverride).not.toHaveBeenCalled();
    expect(r.crsService.current()!.kind).toBe('geocentric');
    expect(r.crsService.current()!.epsg).toBe(4978);
    expect(elevationWorkflowRefusal(r.crsService.context())).not.toBeNull();
    const i = r.toasts.findIndex((t) => KIND_NOTICE.test(t));
    expect(r.toasts[i]).toContain('This session\'s coordinate system, EPSG:4978 (projected), was not applied because the scan declares a geocentric one, WGS 84 (EPSG:4978), which stays in use. EPSG:4978 is a geocentric CRS, not a projected one.');
    // No action: applying it would store an unknown CRS for the scan, and
    // every later open would show unknown instead of geocentric.
    expect(r.actions[i]).toBeUndefined();
    expect(r.store.size).toBe(0);
  });

  it('a geographic 4326 file keeps its CRS under a projected 4326 session, with the notice', async () => {
    const r = await restore(crsFromWkt(WGS84), sessionCrs(4326, 'projected'));
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.setCrsOverride).not.toHaveBeenCalled();
    expect(r.crsService.current()!.kind).toBe('geographic');
    expect(r.crsService.current()!.epsg).toBe(4326);
    const i = r.toasts.findIndex((t) => KIND_NOTICE.test(t));
    expect(r.toasts[i]).toContain('EPSG:4326 is a geographic CRS, not a projected one.');
    expect(r.actions[i]).toBeUndefined();
  });

  it('a session code the EPSG tables do not hold gets the notice without the action', async () => {
    const r = await restore(crsFromWkt(WGS84), sessionCrs(2181, 'projected'));
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.crsService.current()!.kind).toBe('geographic');
    const i = r.toasts.findIndex((t) => KIND_NOTICE.test(t));
    expect(r.toasts[i]).toContain('EPSG:2181 is not in the EPSG tables this app holds, so its kind cannot be checked.');
    expect(r.actions[i]).toBeUndefined();
  });
});

describe('a CRS the session file only records raises no kind conflict', () => {
  it('a geocentric 4978 file with a file-derived projected 4978 session CRS', async () => {
    const r = await restore(crsFromWkt(GEOCENTRIC), sessionCrs(4978, 'projected', true));
    expect(r.ok).toBe(true);
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.setCrsOverride).not.toHaveBeenCalled();
    expect(r.crsService.current()!.kind).toBe('geocentric');
    expect(r.toasts.some((t) => REFUSAL.test(t) || KIND_NOTICE.test(t))).toBe(false);
  });

  it('a geographic 4326 file with a file-derived projected 4326 session CRS', async () => {
    const r = await restore(crsFromWkt(WGS84), sessionCrs(4326, 'projected', true));
    expect(r.ok).toBe(true);
    expect(r.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(r.crsService.current()!.kind).toBe('geographic');
    expect(r.toasts.some((t) => REFUSAL.test(t) || KIND_NOTICE.test(t))).toBe(false);
  });
});

describe('a session that agrees with the scan still applies quietly', () => {
  it('a projected 32612 file under a projected 32612 session', async () => {
    const r = await restore(crsFromWkt(UTM), sessionCrs(32612, 'projected'));
    expect(r.ok).toBe(true);
    expect(r.setCrsOverride).toHaveBeenCalledTimes(1);
    expect(r.crsService.current()!.kind).toBe('projected');
    expect(r.loadMeasurements).toHaveBeenCalled();
    expect(r.toasts.every((t) => !/conflicts with this scan/.test(t))).toBe(true);
    expect(r.toasts.every((t) => !/coordinate system/.test(t))).toBe(true);
  });
});

describe('a file whose GeoKeys contradict their code', () => {
  // GTModelType 2 (geographic) with ProjectedCRSGeoKey 3072=32612.
  const contradictory = crsFromGeoTiff(geoKeys([[1024, 2], [3072, 32612]]), null, null);

  it('takes a session that names the code\'s own kind, and says the CRS changed', async () => {
    const r = await restore(contradictory, sessionCrs(32612, 'projected'));
    expect(r.ok).toBe(true);
    expect(r.setCrsOverride).toHaveBeenCalledTimes(1);
    expect(r.crsService.current()!.kind).toBe('projected');
    expect(r.crsService.current()!.linearUnit).toBe('metre');
    expect(r.toasts.every((t) => !/conflicts with this scan/.test(t))).toBe(true);
    expect(r.toasts.some((t) => /This session set the coordinate system to/.test(t))).toBe(true);
  });
});

describe('detectSessionSpatialConflict compares the CRS kind', () => {
  const base = { upAxis: 'z' as const };

  it('the same code with a different kind is a conflict', () => {
    const v = detectSessionSpatialConflict({ ...base, epsg: 4978, kind: 'projected' }, { epsg: 4978, kind: 'geocentric' });
    expect(v.hasConflict).toBe(true);
    expect(v.conflicts.map((c) => c.field)).toEqual(['kind']);
  });

  it('a different code of a different kind is a code conflict and a kind conflict', () => {
    const v = detectSessionSpatialConflict({ ...base, epsg: 4326, kind: 'geographic' }, { epsg: 32612, kind: 'projected' });
    expect(v.conflicts.map((c) => c.field)).toEqual(['crs', 'kind']);
  });

  it('a local session claims no kind against the file', () => {
    const v = detectSessionSpatialConflict({ ...base, kind: 'local' }, { epsg: 32612, kind: 'projected' });
    expect(v.hasConflict).toBe(false);
  });

  it('a file whose declared kind contradicts the EPSG table for its own code makes no kind claim', () => {
    const v = detectSessionSpatialConflict({ ...base, epsg: 32612, kind: 'projected' }, { epsg: 32612, kind: 'geographic' });
    expect(v.hasConflict).toBe(false);
  });

  it('the same code and kind is no conflict', () => {
    const v = detectSessionSpatialConflict({ ...base, epsg: 32612, kind: 'projected' }, { epsg: 32612, kind: 'projected' });
    expect(v.hasConflict).toBe(false);
  });
});
