/**
 * Restore a session file carrying a CRS onto a streamed scan, through the real
 * import path, and report what the user would see.
 */
import { vi } from 'vitest';
import { importSession, type SessionIoDeps, type SessionModule } from '../../src/app/sessionIo';
import {
  detectSessionSpatialConflict,
  matchSessionToScan,
  parseSession,
  rebaseSessionGeometry,
  serializeSession,
} from '../../src/io/session';
import type { ResolvedCrs } from '../../src/geo/CoordinateTypes';
import { CrsService, type CrsOverridePort } from '../../src/geo/CrsService';
import type { CrsInfo } from '../../src/io/crs';
import type { Viewer } from '../../src/render/Viewer';

const sessionModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict };
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

export interface RestoreOptions {
  /** The session's recorded source point count; 1000 matches the scan. */
  sourcePoints?: number;
  /** Passed to importSession. */
  skipScanConfirm?: boolean;
  /** Wire `currentCrs`, so the notice is decided against the CRS active before the restore. */
  withCurrent?: boolean;
}

/** Restore a session carrying `crs` onto a streamed scan that declares `declared`. */
export async function restoreSession(declared: CrsInfo | null, crs: ResolvedCrs, opts: RestoreOptions = {}) {
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
    ...(opts.withCurrent ? { currentCrs: () => crsService.current() } : {}),
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
    scanSummary: { fileName: 'loaded.laz', sourcePoints: opts.sourcePoints ?? 1000, width: 10, depth: 10, height: 3 },
  } as never));
  const ok = await importSession(file, opts.skipScanConfirm === undefined ? {} : { skipScanConfirm: opts.skipScanConfirm }, deps);
  const toasts = showToast.mock.calls.map((c) => c[0] as string);
  const actions = showToast.mock.calls.map((c) => c[1] as { label: string; onClick: () => void } | undefined);
  return { ok, crsService, store, setCrsOverride, loadMeasurements, toasts, actions };
}
