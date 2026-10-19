/**
 * sessionCrsNotice.test.ts
 *
 * A session that sets the coordinate system tells the user which one, in the
 * toast, with a Keep action. The toast host shows one message at a time, so the
 * notice has to be in the message that is still on screen when the import
 * finishes. This runs the real import against the real toast host and the real
 * CRS service and reads what the user would see after it completes: the
 * restore toast replaced a separate CRS toast before anyone could read it.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { importSession, type SessionIoDeps, type SessionModule } from '../src/app/sessionIo';
import { serializeSession, parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict } from '../src/io/session';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import { createToastHost } from '../src/ui/panelChrome';
import type { Viewer } from '../src/render/Viewer';

class FakeEl {
  className = '';
  readonly dataset: Record<string, string> = {};
  type = '';
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classes = new Set<string>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(t: string, h: () => void): void { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)!).push(h); }
  click(): void { for (const h of this.listeners.get('click') ?? []) h(); }
  blur(): void {}
  get classList() {
    const c = this.classes;
    return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x), toggle: (x: string, on?: boolean) => { if (on ?? !c.has(x)) c.add(x); else c.delete(x); return c.has(x); } };
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

const sessionModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict };
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

const FOOT_CRS: ResolvedCrs = {
  kind: 'projected',
  name: 'NAD83 / California zone 1 (ftUS)',
  epsg: 2225,
  linearUnit: 'us-survey-foot',
  linearUnitToMetres: 1200 / 3937,
  source: 'user-override',
  confidence: 'high',
  userConfirmed: true,
} as ResolvedCrs;

function sessionFile(crs: ResolvedCrs): File {
  return asFile(serializeSession({
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
}

/** The whole import against the real toast host; returns what is on screen after it. */
async function importAndRead(crs: ResolvedCrs, declared: { epsg?: number } | null = null) {
  const body = new FakeEl('body');
  const toast = createToastHost(() => body as unknown as HTMLElement);
  const store = new Map<string, unknown>();
  const crsService = new CrsService({
    get: (k) => store.get(k) as never,
    set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }),
    clear: (k) => void store.delete(k),
  } as CrsOverridePort);
  crsService.resolveForScan({ name: 'loaded.laz', detected: undefined, source: 'las-vlr' });
  const streamingCloud = {
    name: 'loaded.laz',
    sourcePointCount: 1000,
    dataBounds: () => [0, 0, 0, 10, 10, 3],
    crs: () => declared,
  };
  const viewer = {
    clouds: () => [] as string[],
    hasStreamingCloud: true,
    streamingCloud,
    getCloud: () => undefined,
    measure: { loadMeasurements: vi.fn(), getMeasurements: () => [] },
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
    setCrsOverride: (args) => crsService.setOverride(args),
    showToast: (m, a) => toast.show(m, a),
    setDropError: vi.fn(),
  };
  const ok = await importSession(sessionFile(crs), {}, deps);
  const root = body.children[0]!;
  return {
    ok,
    root,
    crsService,
    store,
    text: root.children.filter((c) => c.className === 'olv-lasso-toast-msg').map((c) => c.textContent).join(' '),
    keep: root.children.find((c) => c.tagName === 'button'),
  };
}

describe('session coordinate-system notice after the whole import', () => {
  it('shows the CRS and unit and a Keep button in the toast that is left on screen', async () => {
    const r = await importAndRead(FOOT_CRS);
    expect(r.ok).toBe(true);
    expect(r.root.classes.has('olv-visible')).toBe(true);
    expect(r.text).toContain('Session restored');
    expect(r.text).toContain('This session set the coordinate system to');
    expect(r.text).toContain('EPSG:2225');
    expect(r.text).toContain('not saved on this device');
    expect(r.keep?.textContent).toBe('Keep');
  });

  it('Keep writes the override to the device store, and nothing was written before it', async () => {
    const r = await importAndRead(FOOT_CRS);
    expect(r.store.size).toBe(0);
    r.keep!.click();
    expect(r.store.size).toBe(1);
  });

  it('prints no notice and no button when the session agrees with the file', async () => {
    const r = await importAndRead({ ...FOOT_CRS, epsg: 32613, name: 'WGS 84 / UTM zone 13N', linearUnit: 'metre', linearUnitToMetres: 1 }, { epsg: 32613 });
    expect(r.text).toContain('Session restored');
    expect(r.text).not.toContain('coordinate system');
    expect(r.keep).toBeUndefined();
  });
});
