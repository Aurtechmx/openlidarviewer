import { describe, it, expect } from 'vitest';
import { createScanService } from '../src/app/ScanService';
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
