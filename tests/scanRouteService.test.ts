import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScanRouteService } from '../src/app/ScanRouteService';
import { createAppContext } from '../src/app/appContext';

describe('ScanRouteService', () => {
  it('starts unpinned on automatic detection', () => {
    const svc = createScanRouteService(createAppContext());
    expect(svc.overridden).toBe(false);
    expect(svc.typeOverride).toBe('auto');
    expect(svc.pinned).toBe(false);
  });

  it('a panel override pins the route', () => {
    const svc = createScanRouteService(createAppContext());
    svc.pin();
    expect(svc.overridden).toBe(true);
    expect(svc.pinned).toBe(true);
  });

  it('a manual scan-type choice pins the route even without a panel override', () => {
    // This is the half of the predicate that was easy to forget at a call site:
    // detection must not flip the route after the user picked a type.
    const svc = createScanRouteService(createAppContext());
    svc.setTypeOverride('terrain');
    expect(svc.overridden).toBe(false);
    expect(svc.pinned).toBe(true);
  });

  it("choosing 'auto' again leaves the route unpinned", () => {
    const svc = createScanRouteService(createAppContext());
    svc.setTypeOverride('object');
    svc.setTypeOverride('auto');
    expect(svc.pinned).toBe(false);
  });

  it('reset returns to automatic detection from either kind of pin', () => {
    const svc = createScanRouteService(createAppContext());
    svc.pin();
    svc.setTypeOverride('interior');
    svc.reset();
    expect(svc.overridden).toBe(false);
    expect(svc.typeOverride).toBe('auto');
    expect(svc.pinned).toBe(false);
  });

  it('writes through to the shared AppContext cluster', () => {
    const ctx = createAppContext();
    const svc = createScanRouteService(ctx);
    svc.pin();
    svc.setTypeOverride('terrain');
    expect(ctx.scanRoute).toEqual({ overridden: true, typeOverride: 'terrain' });
  });

  describe('debounced re-route', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs the scheduled re-route after the delay', () => {
      const svc = createScanRouteService(createAppContext());
      const run = vi.fn();
      svc.schedule(run, 500);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('a second schedule replaces the pending one — only the last runs', () => {
      const svc = createScanRouteService(createAppContext());
      const first = vi.fn();
      const second = vi.fn();
      svc.schedule(first, 500);
      vi.advanceTimersByTime(200);
      svc.schedule(second, 500);
      vi.advanceTimersByTime(500);
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it('cancelScheduled stops a pending re-route (scan closed before it fired)', () => {
      const svc = createScanRouteService(createAppContext());
      const run = vi.fn();
      svc.schedule(run, 500);
      svc.cancelScheduled();
      vi.advanceTimersByTime(1000);
      expect(run).not.toHaveBeenCalled();
    });
  });
});
