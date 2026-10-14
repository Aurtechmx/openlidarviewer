/**
 * The shared replace guard: which work counts as at risk, what Save / Replace /
 * Cancel do, and that a streamed scan opened over existing work never keeps it
 * under the new scan's identity.
 */
import { describe, it, expect, vi } from 'vitest';
import { requestReplace, wouldLoseWork, workAtRisk, type ReplaceGuardDeps } from '../src/app/discardGuard';
import type { DiscardableWork } from '../src/app/closeScanGuard';
import { guardReplacedWork, settleReplacedWork } from '../src/app/openStreaming';
import { LoadCancelledError } from '../src/io/loadFile';
import { partitionSessionWork, RETIRED_SCAN_OWNER, type OwnershipView } from '../src/app/measurementOwnership';
import { serializeActiveSession, type SessionSnapshotDeps } from '../src/app/sessionSnapshot';
import * as sessionIo from '../src/io/session';
import { parseSession } from '../src/io/session';

const none: DiscardableWork = { measurements: 0, annotations: 0, views: 0, classEdits: false, results: 0, pendingRecovery: false };
const some = (over: Partial<DiscardableWork> = {}): DiscardableWork => ({ ...none, measurements: 2, ...over });

function guardDeps(work: DiscardableWork, over: Partial<ReplaceGuardDeps> = {}) {
  const confirm = vi.fn();
  const saveSession = vi.fn(async () => true);
  const snapshot = vi.fn(async () => true);
  const notify = vi.fn();
  const deps: ReplaceGuardDeps = { work: () => work, confirm, saveSession, snapshot, notify, ...over };
  return { deps, confirm, saveSession, snapshot, notify };
}

describe('work detection', () => {
  it('counts measurements, annotations, views and class edits for a scan replacement', () => {
    expect(wouldLoseWork(none, { kind: 'scan', name: 'a' })).toBe(false);
    expect(wouldLoseWork({ ...none, annotations: 1 }, { kind: 'scan', name: 'a' })).toBe(true);
    expect(wouldLoseWork({ ...none, views: 1 }, { kind: 'scan', name: 'a' })).toBe(true);
    expect(wouldLoseWork({ ...none, classEdits: true }, { kind: 'scan', name: 'a' })).toBe(true);
  });
  it('ignores computed results and the recovery journal, which a replacement does not discard', () => {
    expect(wouldLoseWork({ ...none, results: 3, pendingRecovery: true }, { kind: 'scan', name: 'a' })).toBe(false);
  });
  it('counts only measurements, annotations and views for an import', () => {
    expect(workAtRisk(some({ classEdits: true, results: 1 }), 'import')).toEqual({ ...none, measurements: 2 });
    expect(wouldLoseWork({ ...none, classEdits: true }, { kind: 'import', name: 'a' })).toBe(false);
  });
  it('asks nothing when the file holds the work already open', () => {
    expect(wouldLoseWork(some(), { kind: 'import', name: 'a', identical: true })).toBe(false);
  });
});

describe('requestReplace', () => {
  it('asks nothing and answers none when no work is at risk', async () => {
    const { deps, confirm } = guardDeps(none);
    expect(await requestReplace({ kind: 'scan', name: 'a.copc.laz' }, deps)).toBe('none');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('Cancel changes nothing: no save, no snapshot', async () => {
    const { deps, confirm, saveSession, snapshot } = guardDeps(some());
    confirm.mockResolvedValue('cancel');
    expect(await requestReplace({ kind: 'scan', name: 'a' }, deps)).toBe('cancel');
    expect(saveSession).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });
  it('Replace keeps a recovery snapshot, then lets the caller discard', async () => {
    const { deps, confirm, saveSession, snapshot, notify } = guardDeps(some());
    confirm.mockResolvedValue('confirm');
    expect(await requestReplace({ kind: 'scan', name: 'a' }, deps)).toBe('replace');
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(saveSession).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('kept for recovery'));
  });
  it('Replace does not claim a snapshot that was not stored', async () => {
    const { deps, confirm, notify } = guardDeps(some(), { snapshot: async () => false });
    confirm.mockResolvedValue('confirm');
    expect(await requestReplace({ kind: 'scan', name: 'a' }, deps)).toBe('replace');
    expect(notify).not.toHaveBeenCalled();
  });
  it('Save runs the session save first and only then answers replace', async () => {
    const order: string[] = [];
    const { deps, confirm } = guardDeps(some(), { saveSession: async () => { order.push('save'); return true; } });
    confirm.mockResolvedValue('alternate');
    const out = await requestReplace({ kind: 'import', name: 'a' }, deps);
    order.push(out);
    expect(order).toEqual(['save', 'replace']);
  });
  it('a failed save cancels and says so', async () => {
    const { deps, confirm, notify } = guardDeps(some(), { saveSession: async () => false });
    confirm.mockResolvedValue('alternate');
    expect(await requestReplace({ kind: 'scan', name: 'a' }, deps)).toBe('cancel');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('not saved'));
  });
  it('does not offer Save when only class edits are at risk', async () => {
    const { deps, confirm } = guardDeps({ ...none, classEdits: true });
    confirm.mockResolvedValue('cancel');
    await requestReplace({ kind: 'scan', name: 'a' }, deps);
    expect(confirm.mock.calls[0]![0]).not.toHaveProperty('alternateLabel');
  });
  it('a second request while the dialog is open is refused instead of stacking', async () => {
    let release: (v: 'confirm') => void = () => {};
    const { deps, confirm } = guardDeps(some());
    confirm.mockReturnValue(new Promise((r) => { release = r; }));
    const first = requestReplace({ kind: 'scan', name: 'a' }, deps);
    expect(await requestReplace({ kind: 'import', name: 'b' }, deps)).toBe('cancel');
    expect(confirm).toHaveBeenCalledTimes(1);
    release('confirm');
    expect(await first).toBe('replace');
  });
});

// A viewer whose work stores behave as the real ones do for the calls used here.
function fakeViewer(initial: Array<{ id: string; owner?: { layerId: string; frame: 'project' } }>) {
  const measurements = initial.map((m) => ({ ...m }));
  const annotations = initial.map((m) => ({ ...m, id: `n${m.id}` }));
  const claim = (list: Array<{ owner?: unknown }>) => (layerId: string) => { for (const i of list) if (!i.owner) i.owner = { layerId, frame: 'project' }; };
  return {
    measurements, annotations,
    measure: { clear: vi.fn(() => { measurements.length = 0; }), claimUnowned: claim(measurements) },
    annotate: { clear: vi.fn(() => { annotations.length = 0; }), claimUnowned: claim(annotations) },
  };
}

describe('a streamed scan opened over existing work', () => {
  it('Cancel stops the open before anything changes', async () => {
    const v = fakeViewer([{ id: 'm1' }]);
    const bookmarks = { clear: vi.fn() };
    const replaceGuard = vi.fn(async () => 'cancel' as const);
    await expect(guardReplacedWork({ replaceGuard }, 'big.copc.laz')).rejects.toBeInstanceOf(LoadCancelledError);
    expect(v.measurements).toHaveLength(1);
    expect(bookmarks.clear).not.toHaveBeenCalled();
  });
  it('Replace clears measurements, annotations and saved views once the scan is committed', async () => {
    const v = fakeViewer([{ id: 'm1' }]);
    const bookmarks = { clear: vi.fn() };
    const refreshViewsUI = vi.fn();
    const out = await guardReplacedWork({ replaceGuard: async () => 'replace' }, 'x');
    settleReplacedWork({ getViewer: () => v as never, bookmarks, refreshViewsUI }, out);
    expect(v.measurements).toHaveLength(0);
    expect(v.annotations).toHaveLength(0);
    expect(bookmarks.clear).toHaveBeenCalled();
    expect(refreshViewsUI).toHaveBeenCalled();
  });
  it('with no guard wired, nothing is asked and leftover work is marked as belonging to the retired scan', async () => {
    const v = fakeViewer([{ id: 'm1' }]);
    const out = await guardReplacedWork({}, 'x');
    expect(out).toBe('none');
    settleReplacedWork({ getViewer: () => v as never, bookmarks: { clear: vi.fn() }, refreshViewsUI: vi.fn() }, out);
    expect(v.measurements[0]!.owner).toEqual({ layerId: RETIRED_SCAN_OWNER, frame: 'project' });
    expect(v.annotations[0]!.owner).toEqual({ layerId: RETIRED_SCAN_OWNER, frame: 'project' });
  });
});

describe('the session serializer and work from a retired scan', () => {
  const streamingView: OwnershipView = { layers: [], activeViewerId: null };

  it('partitionSessionWork keeps unowned and other-layer work and leaves out work whose scan is gone', () => {
    const view: OwnershipView = { layers: [{ viewerId: 'v1', stableId: 'layer_a', name: 'a' }, { viewerId: 'v2', stableId: 'layer_b', name: 'b' }], activeViewerId: 'v1' };
    const items = [
      { id: 'own', owner: { layerId: 'layer_a', frame: 'project' as const } },
      { id: 'other', owner: { layerId: 'layer_b', frame: 'project' as const } },
      { id: 'gone', owner: { layerId: 'layer_z', frame: 'project' as const } },
    ];
    const out = partitionSessionWork(items, view);
    expect(out.keep.map((i) => i.id)).toEqual(['own', 'other']);
    expect(out.leftOut).toBe(1);
  });

  function snapshotDeps(measurements: unknown[], annotations: unknown[], onWithheld?: (m: string) => void): SessionSnapshotDeps {
    const viewer = {
      streamingCloud: { name: 'new.copc.laz', sourcePointCount: 10, dataBounds: () => [0, 0, 0, 1, 1, 1], crs: () => null },
      measure: { unitSystem: 'metric', getMeasurements: () => measurements },
      annotate: { getAnnotations: () => annotations },
    };
    return {
      getViewer: () => viewer as never, activeCloud: () => null, analysedResult: () => null, verticalUnitToMetres: () => null,
      captureViewState: () => ({}) as never, savedViews: () => [], origin: () => [0, 0, 0], crs: () => null, layerGroups: () => [],
      appVersion: 'test', ownershipView: () => streamingView, ...(onWithheld ? { onWithheld } : {}),
    };
  }

  it('never writes work retired with the old scan under the new scan, and says why', () => {
    const retired = { layerId: RETIRED_SCAN_OWNER, frame: 'project' as const };
    const m = [{ id: 'old', kind: 'distance', name: 'D', points: [[1, 0, 0], [2, 0, 0]], owner: retired }];
    const a = [{ id: 'olda', owner: retired, localPosition: [0, 0, 0], text: 't', title: 't', createdAt: 0 }];
    const withheld = vi.fn();
    const text = serializeActiveSession(sessionIo, snapshotDeps(m, a, withheld));
    const session = parseSession(text);
    expect(session.measurements).toHaveLength(0);
    expect(session.annotations).toHaveLength(0);
    expect(session.scanSummary?.fileName).toBe('new.copc.laz');
    expect(withheld).toHaveBeenCalledWith(expect.stringContaining('no longer open'));
  });

  it('still writes work taken on the streamed scan itself', () => {
    const m = [{ id: 'mine', kind: 'distance', name: 'D', points: [[1, 0, 0], [2, 0, 0]] }];
    const withheld = vi.fn();
    const session = parseSession(serializeActiveSession(sessionIo, snapshotDeps(m, [], withheld)));
    expect(session.measurements.map((x) => x.id)).toEqual(['mine']);
    expect(withheld).not.toHaveBeenCalled();
  });
});
