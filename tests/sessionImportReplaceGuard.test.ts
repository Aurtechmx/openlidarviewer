/**
 * Importing a session over work that is already open: the file replaces it only
 * after Save / Replace / Cancel, a bad file changes nothing, and an import with
 * nothing at risk asks nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { importSession, sameSessionWork, type SessionIoDeps, type SessionModule } from '../src/app/sessionIo';
import { requestReplace, type ReplaceGuardDeps } from '../src/app/discardGuard';
import { serializeSession, parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict } from '../src/io/session';
import type { Viewer } from '../src/render/Viewer';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import type { DiscardableWork } from '../src/app/closeScanGuard';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];
const asFile = (text: string, name = 'earlier.olvsession'): File => ({ text: async () => text, name, size: text.length }) as unknown as File;
const m1: Measurement = { id: 'm1', kind: 'distance', name: 'D1', points: [p(0, 0, 0), p(1, 0, 0)] };
const m2: Measurement = { id: 'm2', kind: 'distance', name: 'D2', points: [p(0, 0, 0), p(0, 2, 0)] };

const json = (measurements: Measurement[]): string => serializeSession({ upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements, annotations: [], software: '0.6.3' });
const realModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan, detectSessionSpatialConflict };

function harness(open: Measurement[], choice: 'confirm' | 'alternate' | 'cancel' | null) {
  const store = { measurements: [...open] };
  const loadMeasurements = vi.fn((list: Measurement[]) => { store.measurements = [...list]; });
  const loadAnnotations = vi.fn();
  const restore = vi.fn();
  const showToast = vi.fn();
  const setDropError = vi.fn();
  const setCrsOverride = vi.fn();
  const snapshot = vi.fn(async () => true);
  const saveSession = vi.fn(async () => true);
  const confirm = vi.fn(async () => choice ?? 'cancel');
  const viewer = {
    clouds: () => [] as string[], hasStreamingCloud: false, streamingCloud: null, getCloud: () => undefined,
    measure: { loadMeasurements, getMeasurements: () => store.measurements },
    annotate: { loadAnnotations, getAnnotations: () => [] },
  };
  const work = (): DiscardableWork => ({ measurements: store.measurements.length, annotations: 0, views: 0, classEdits: false, results: 0 });
  const guard: ReplaceGuardDeps = { work, confirm, saveSession, snapshot };
  const deps: SessionIoDeps = {
    viewerReady: Promise.resolve(), getViewer: () => viewer as unknown as Viewer, loadSession: async () => realModule, appVersion: '0.6.3',
    getActiveScanId: () => null, getActiveLayerId: () => null, getActiveCloud: () => null, exportOrigin: () => [0, 0, 0],
    bookmarks: { restore, names: () => [] }, setInspectorViews: vi.fn(), restoreLayerGroups: vi.fn(), refreshMeasurePanel: vi.fn(),
    refreshAnnotationPanel: vi.fn(), applyViewState: vi.fn(), setCrsOverride, showToast, setDropError,
    confirmReplace: (req) => requestReplace(req, guard), currentViews: () => [],
  };
  return { deps, store, confirm, snapshot, saveSession, loadMeasurements, restore, showToast, setDropError };
}

describe('session import over work already open', () => {
  it('Cancel leaves the open work, views and scene exactly as they were', async () => {
    const h = harness([m1, m2], 'cancel');
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(false);
    expect(h.store.measurements.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(h.loadMeasurements).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
  });
  it('Replace imports the file and keeps a recovery snapshot of what it replaced', async () => {
    const h = harness([m1, m2], 'confirm');
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(true);
    expect(h.store.measurements.map((m) => m.id)).toEqual(['m1']);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
  });
  it('Save writes the current session before the file is applied', async () => {
    const h = harness([m1, m2], 'alternate');
    const order: string[] = [];
    h.saveSession.mockImplementation(async () => { order.push('save'); return true; });
    h.loadMeasurements.mockImplementation(() => { order.push('apply'); });
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(true);
    expect(order).toEqual(['save', 'apply']);
  });
  it('a failed save applies nothing', async () => {
    const h = harness([m1, m2], 'alternate');
    h.saveSession.mockResolvedValue(false);
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(false);
    expect(h.loadMeasurements).not.toHaveBeenCalled();
  });
  it('asks nothing on an empty viewer', async () => {
    const h = harness([], 'cancel');
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.store.measurements.map((m) => m.id)).toEqual(['m1']);
  });
  it('asks nothing when the file holds exactly the work already open', async () => {
    const h = harness([m1], 'cancel');
    expect(await importSession(asFile(json([m1])), {}, h.deps)).toBe(true);
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it('asks nothing when a session imported before its scan is re-applied onto that scan', async () => {
    const h = harness([m1, m2], 'cancel');
    await importSession(asFile(json([m1])), { reapply: true }, h.deps);
    expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each([['not json{'], [JSON.stringify({ app: 'Other', kind: 'x', version: 7 })]])('a bad file changes nothing and asks nothing (%s)', async (text) => {
    const h = harness([m1, m2], 'confirm');
    expect(await importSession(asFile(text), {}, h.deps)).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.loadMeasurements).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.store.measurements).toHaveLength(2);
    expect(h.setDropError).toHaveBeenCalled();
  });
});

describe('sameSessionWork', () => {
  const renamed: Measurement = { ...m1, name: 'renamed' };
  it('is true only for identical work', () => {
    expect(sameSessionWork({ measurements: [m1], annotations: [], views: [] }, { measurements: [m1], annotations: [], views: [] })).toBe(true);
    expect(sameSessionWork({ measurements: [m1, m2], annotations: [], views: [] }, { measurements: [m1], annotations: [], views: [] })).toBe(false);
    expect(sameSessionWork({ measurements: [m1], annotations: [], views: [] }, { measurements: [renamed], annotations: [], views: [] })).toBe(false);
  });
});
