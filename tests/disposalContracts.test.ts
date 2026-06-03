/**
 * disposalContracts.test.ts
 *
 * Contract tests for the pure modules' disposal + cancellation
 * surfaces. These exercise the seams that leak silently if a future
 * change drops a clearTimeout / forgets a listener detach / mishandles
 * a "closed" flag. The harder surfaces (Viewer, three.js, streaming
 * workers, COPC worker, GPU textures and buffers) live in the e2e
 * suite and are documented in `docs/disposal-contracts.md`.
 *
 * Every test asserts EVIDENCE not just intent — a leak shows up as a
 * non-zero counter or a still-pending fake timer, not as a missing
 * "did cleanup happen?" check.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildWorkflow,
  parseWorkflow,
  scheduleReplay,
  WorkflowSession,
  type ReplayDeps,
  type WorkflowEvent,
} from '../src/render/workflow/workflowRecorder';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { CrsInfo } from '../src/io/crs';

// ── fakes ───────────────────────────────────────────────────────────

/**
 * A fake timer host that records every setTimeout / clearTimeout call
 * so a leak test can assert "no pending fires remain". Mirrors the
 * `ReplayDeps` shape the recorder consumes.
 */
function makeFakeTimerHost(): ReplayDeps & {
  pending: () => number;
  fireAll: () => void;
} {
  let nextId = 1;
  const pending = new Map<
    number,
    { fn: () => void; cancelled: boolean }
  >();
  return {
    setTimeout(fn: () => void): number {
      const id = nextId++;
      pending.set(id, { fn, cancelled: false });
      return id;
    },
    clearTimeout(handle: unknown): void {
      if (typeof handle !== 'number') return;
      const entry = pending.get(handle);
      if (entry) entry.cancelled = true;
      pending.delete(handle);
    },
    pending: () => pending.size,
    fireAll: () => {
      // Snapshot then fire — firing inside the loop can cancel siblings.
      const toFire = [...pending.entries()];
      for (const [id, entry] of toFire) {
        if (entry.cancelled) continue;
        pending.delete(id);
        entry.fn();
      }
    },
  };
}

/** A fresh in-memory port for CrsService. */
function makePort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return {
    get: (k) => store.get(k),
    set: (k, override) =>
      void store.set(k, { ...override, updatedAt: Date.now() }),
    clear: (k) => void store.delete(k),
  };
}

const STATIC_CRS: CrsInfo = {
  source: 'wkt',
  name: 'NAD83 / UTM zone 18N',
  epsg: 26918,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

// ── WorkflowSession + scheduleReplay disposal ───────────────────────

describe('scheduleReplay — timer disposal', () => {
  it('cancel() clears every pending timer with no leftovers', () => {
    const timer = makeFakeTimerHost();
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 100 },
      { type: 'camera-preset', name: 'iso', tMs: 200 },
      { type: 'frame-all', tMs: 300 },
    ]);
    const handle = scheduleReplay(wf, () => {}, timer);
    expect(timer.pending()).toBe(3);
    handle.cancel();
    expect(timer.pending()).toBe(0);
  });

  it('cancel() is idempotent — calling twice does not throw or leak', () => {
    const timer = makeFakeTimerHost();
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 0 },
    ]);
    const handle = scheduleReplay(wf, () => {}, timer);
    expect(() => {
      handle.cancel();
      handle.cancel();
      handle.cancel();
    }).not.toThrow();
    expect(timer.pending()).toBe(0);
  });

  it('cancel() prevents dispatch even when the timer already fired', () => {
    const timer = makeFakeTimerHost();
    const dispatch = vi.fn();
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 0 },
    ]);
    const handle = scheduleReplay(wf, dispatch, timer);
    handle.cancel();
    // Simulate the fake timer firing AFTER cancel — the guard inside
    // scheduleReplay should make this a no-op.
    timer.fireAll();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('repeated schedule + cancel cycles leave zero pending timers', () => {
    const timer = makeFakeTimerHost();
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 100 },
      { type: 'camera-preset', name: 'iso', tMs: 200 },
    ]);
    for (let i = 0; i < 50; i++) {
      const h = scheduleReplay(wf, () => {}, timer);
      h.cancel();
    }
    expect(timer.pending()).toBe(0);
  });

  it('fires onComplete exactly once on an empty workflow', () => {
    const timer = makeFakeTimerHost();
    const onComplete = vi.fn();
    scheduleReplay(buildWorkflow([]), () => {}, {
      ...timer,
      onComplete,
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('fires onComplete after every event runs', () => {
    const timer = makeFakeTimerHost();
    const onComplete = vi.fn();
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 0 },
      { type: 'camera-preset', name: 'iso', tMs: 0 },
    ]);
    scheduleReplay(wf, () => {}, { ...timer, onComplete });
    expect(onComplete).not.toHaveBeenCalled();
    timer.fireAll();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('does not call dispatch for cancelled fires that already fired in chain', () => {
    const timer = makeFakeTimerHost();
    const dispatch = vi.fn();
    // 3 events scheduled, cancel after firing the first.
    const wf = buildWorkflow([
      { type: 'camera-preset', name: 'top', tMs: 0 },
      { type: 'camera-preset', name: 'iso', tMs: 0 },
      { type: 'camera-preset', name: 'oblique', tMs: 0 },
    ]);
    let handle: { cancel: () => void } | null = null;
    handle = scheduleReplay(
      wf,
      (e) => {
        dispatch(e);
        if (e.type === 'camera-preset' && e.name === 'top') {
          handle?.cancel();
        }
      },
      timer,
    );
    timer.fireAll();
    // dispatch fired for "top" only; the cancel inside dispatch
    // emptied the pending map before "iso" and "oblique" could run.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('WorkflowSession — event accumulation', () => {
  it('a fresh session reports zero events', () => {
    const session = new WorkflowSession(() => 0);
    expect(session.events().length).toBe(0);
    expect(session.hasContent).toBe(false);
  });

  it('push appends in order with monotonic tMs', () => {
    let t = 0;
    const session = new WorkflowSession(() => t);
    session.push({ type: 'camera-preset', name: 'top' });
    t = 100;
    session.push({ type: 'camera-preset', name: 'iso' });
    t = 250;
    session.push({ type: 'frame-all' });
    expect(session.events().map((e) => e.tMs)).toEqual([0, 100, 250]);
  });

  it('events() returns a defensive copy — mutating the result does not poison the session', () => {
    const session = new WorkflowSession(() => 0);
    session.push({ type: 'camera-preset', name: 'top' });
    const snap = session.events();
    snap.length = 0;
    expect(session.events().length).toBe(1);
  });
});

// ── parseWorkflow defensive contract ────────────────────────────────

describe('parseWorkflow — malformed input safety', () => {
  it('returns an error result for non-JSON input', () => {
    const r = parseWorkflow('not json at all');
    expect(r.ok).toBe(false);
  });

  it('returns an error result for an object missing kind', () => {
    const r = parseWorkflow(JSON.stringify({ version: 1, events: [] }));
    expect(r.ok).toBe(false);
  });

  it('returns an error result for events with an unknown type', () => {
    const r = parseWorkflow(
      JSON.stringify({
        kind: 'olvworkflow',
        version: 1,
        recordedAt: new Date().toISOString(),
        events: [{ type: 'mystery', tMs: 0 }],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('round-trips a clean workflow via serialise + parse', () => {
    const events: WorkflowEvent[] = [
      { type: 'camera-preset', name: 'top', tMs: 0 },
      { type: 'theme', name: 'dark', tMs: 100 },
    ];
    const wf = buildWorkflow(events);
    const json = JSON.stringify(wf);
    const r = parseWorkflow(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.workflow.events.length).toBe(2);
    }
  });
});

// ── CrsService disposal stress ──────────────────────────────────────

describe('CrsService — disposal under stress', () => {
  it('clear() releases the resolved CRS for GC', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'a.laz',
      detected: STATIC_CRS,
      source: 'las-vlr',
    });
    expect(svc.current()).not.toBeNull();
    svc.clear();
    expect(svc.current()).toBeNull();
  });

  it('subscriber count drops back to 0 after all unsubscribes (no listener leak)', () => {
    const svc = new CrsService(makePort());
    const detach: Array<() => void> = [];
    for (let i = 0; i < 100; i++) {
      detach.push(svc.subscribe(() => {}));
    }
    expect(svc.subscriberCount()).toBe(100);
    for (const fn of detach) fn();
    expect(svc.subscriberCount()).toBe(0);
  });

  it('repeated open/close cycles do not retain subscriptions', () => {
    const svc = new CrsService(makePort());
    const detach = svc.subscribe(() => {});
    for (let i = 0; i < 50; i++) {
      svc.resolveForScan({
        name: `scan-${i}.laz`,
        detected: STATIC_CRS,
        source: 'las-vlr',
      });
      svc.clear();
    }
    expect(svc.subscriberCount()).toBe(1);
    detach();
    expect(svc.subscriberCount()).toBe(0);
  });

  it('idempotent unsubscribe — calling twice is safe', () => {
    const svc = new CrsService(makePort());
    const detach = svc.subscribe(() => {});
    expect(() => {
      detach();
      detach();
    }).not.toThrow();
    expect(svc.subscriberCount()).toBe(0);
  });
});
