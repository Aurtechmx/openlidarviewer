import { describe, it, expect } from 'vitest';
import { createScanService, survivorAfterRemoval } from '../src/app/ScanService';
import { createAppContext } from '../src/app/appContext';
import type { Viewer } from '../src/render/Viewer';
import type { PointCloud } from '../src/model/PointCloud';

/** A viewer stub exposing only the one method the service reads. */
function viewerWith(clouds: Record<string, PointCloud>): Viewer {
  return { getCloud: (id: string) => clouds[id] } as unknown as Viewer;
}

const CLOUD_A = { name: 'a' } as unknown as PointCloud;

describe('ScanService', () => {
  it('starts with no selection', () => {
    const svc = createScanService({ getViewer: () => viewerWith({}), context: createAppContext() });
    expect(svc.activeId).toBeNull();
    expect(svc.activeCloud()).toBeNull();
  });

  it('setActive selects, clear deselects', () => {
    const svc = createScanService({ getViewer: () => viewerWith({}), context: createAppContext() });
    svc.setActive('cloud-1');
    expect(svc.activeId).toBe('cloud-1');
    svc.clear();
    expect(svc.activeId).toBeNull();
  });

  it('clearIf only clears when the id matches — a different layer closing is a no-op', () => {
    const svc = createScanService({ getViewer: () => viewerWith({}), context: createAppContext() });
    svc.setActive('cloud-1');
    svc.clearIf('cloud-2');
    expect(svc.activeId).toBe('cloud-1');
    svc.clearIf('cloud-1');
    expect(svc.activeId).toBeNull();
  });

  it('activeCloud resolves the selection through the viewer', () => {
    const svc = createScanService({
      getViewer: () => viewerWith({ 'cloud-1': CLOUD_A }),
      context: createAppContext(),
    });
    svc.setActive('cloud-1');
    expect(svc.activeCloud()).toBe(CLOUD_A);
  });

  it('activeCloud is null when the selected id is no longer loaded', () => {
    // The selection can outlive the cloud (removed mid-flight); the lookup must
    // report null rather than undefined, which is what the ~11 call sites expect.
    const svc = createScanService({ getViewer: () => viewerWith({}), context: createAppContext() });
    svc.setActive('gone');
    expect(svc.activeCloud()).toBeNull();
  });

  it('writes through to the shared AppContext cluster', () => {
    const ctx = createAppContext();
    const svc = createScanService({ getViewer: () => viewerWith({}), context: ctx });
    svc.setActive('cloud-1');
    expect(ctx.scan.activeId).toBe('cloud-1');
  });
});

describe('survivorAfterRemoval', () => {
  it('promotes the next layer in open order when the active layer is removed', () => {
    expect(survivorAfterRemoval(['a', 'b', 'c'], 'b', 'b')).toBe('c');
  });

  it('promotes the previous layer when the removed active layer was last', () => {
    expect(survivorAfterRemoval(['a', 'b', 'c'], 'c', 'c')).toBe('b');
  });

  it('keeps the active layer when another layer is removed', () => {
    expect(survivorAfterRemoval(['a', 'b', 'c'], 'a', 'c')).toBe('c');
    expect(survivorAfterRemoval(['a', 'b'], 'b', 'a')).toBe('a');
  });

  it('has no survivor when the last layer is removed', () => {
    expect(survivorAfterRemoval(['a'], 'a', 'a')).toBeNull();
  });

  it('promotes nothing when no static layer was active (a streaming scan keeps the identity)', () => {
    expect(survivorAfterRemoval(['a', 'b'], 'a', null)).toBeNull();
  });

  it('promotes nothing for an id that is not open', () => {
    expect(survivorAfterRemoval(['a', 'b'], 'x', 'x')).toBeNull();
  });
});
