/**
 * frameTelemetry.test.ts — the v0.5.5 P0 per-frame telemetry collector.
 *
 * Covers: nearest-rank percentile math against hand-computed fixtures, the
 * allocation-free ring's window/counter behavior, and the collector's
 * lifecycle contract — NOTHING registered or allocated until start(), a
 * clean teardown on stop(), and honest nulls where `longtask` is
 * unsupported. All browser hooks are injected, so this runs in plain Node.
 */

import {
  percentileSorted,
  FrameTimeRing,
  FrameTelemetry,
  type LongTaskObserverLike,
} from '../src/perf/frameTelemetry';

// ── percentile math (hand-computed nearest-rank fixtures) ───────────────────

describe('percentileSorted — nearest-rank definition', () => {
  it('single sample: every percentile is that sample', () => {
    expect(percentileSorted([10], 1, 50)).toBe(10);
    expect(percentileSorted([10], 1, 95)).toBe(10);
    expect(percentileSorted([10], 1, 99)).toBe(10);
  });

  it('n=10 of 1..10: p50=5 (rank 5), p95=10 (rank 10), p99=10', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentileSorted(v, 10, 50)).toBe(5);
    expect(percentileSorted(v, 10, 95)).toBe(10);
    expect(percentileSorted(v, 10, 99)).toBe(10);
  });

  it('n=20 of 1..20: p50=10 (rank 10), p95=19 (rank 19), p99=20 (rank 20)', () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentileSorted(v, 20, 50)).toBe(10);
    expect(percentileSorted(v, 20, 95)).toBe(19);
    expect(percentileSorted(v, 20, 99)).toBe(20);
  });

  it('n=100 of 1..100: p50=50, p95=95, p99=99', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileSorted(v, 100, 50)).toBe(50);
    expect(percentileSorted(v, 100, 95)).toBe(95);
    expect(percentileSorted(v, 100, 99)).toBe(99);
  });

  it('empty window reads 0', () => {
    expect(percentileSorted([], 0, 50)).toBe(0);
  });
});

// ── ring buffer ──────────────────────────────────────────────────────────────

describe('FrameTimeRing', () => {
  it('wraps at capacity: window keeps the newest N samples', () => {
    const ring = new FrameTimeRing(4);
    for (const v of [1, 2, 3, 4, 5, 6]) ring.push(v);
    // Window is {3,4,5,6}: p50 = rank ceil(2)=2 → 4; max = 6.
    const s = ring.snapshot();
    expect(s.count).toBe(4);
    expect(s.p50).toBe(4);
    expect(s.max).toBe(6);
    expect(ring.totalFrames).toBe(6);
  });

  it('counts over-budget frames cumulatively (survives window wrap)', () => {
    const ring = new FrameTimeRing(2);
    ring.push(10); // under both
    ring.push(20); // > 16.7
    ring.push(40); // > 16.7 and > 33.3
    ring.push(16.7); // NOT > 16.7 (strict)
    expect(ring.framesOver16_7).toBe(2);
    expect(ring.framesOver33_3).toBe(1);
    expect(ring.totalFrames).toBe(4);
    expect(ring.windowCount).toBe(2);
  });

  it('ignores non-finite and negative samples', () => {
    const ring = new FrameTimeRing(4);
    ring.push(NaN);
    ring.push(Infinity);
    ring.push(-5);
    expect(ring.totalFrames).toBe(0);
    expect(ring.snapshot().count).toBe(0);
  });

  it('reset clears the window and every counter', () => {
    const ring = new FrameTimeRing(4);
    ring.push(50);
    ring.reset();
    expect(ring.totalFrames).toBe(0);
    expect(ring.framesOver16_7).toBe(0);
    expect(ring.framesOver33_3).toBe(0);
    expect(ring.snapshot()).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });

  it('rejects a nonsensical capacity', () => {
    expect(() => new FrameTimeRing(0)).toThrow();
  });
});

// ── the collector lifecycle ──────────────────────────────────────────────────

/** Counting mock PerformanceObserver with a hook to emit long tasks. */
class MockObserver implements LongTaskObserverLike {
  static instances = 0;
  static observeCalls = 0;
  static disconnectCalls = 0;
  static last: MockObserver | null = null;
  private readonly _cb: (list: { getEntries(): { duration: number }[] }) => void;

  constructor(cb: (list: { getEntries(): { duration: number }[] }) => void) {
    MockObserver.instances++;
    MockObserver.last = this;
    this._cb = cb;
  }
  observe(): void {
    MockObserver.observeCalls++;
  }
  disconnect(): void {
    MockObserver.disconnectCalls++;
  }
  emit(durations: number[]): void {
    this._cb({ getEntries: () => durations.map((duration) => ({ duration })) });
  }
  static reset(): void {
    MockObserver.instances = 0;
    MockObserver.observeCalls = 0;
    MockObserver.disconnectCalls = 0;
    MockObserver.last = null;
  }
}

/** A deterministic rAF/now harness. */
function makeHarness(observer: typeof MockObserver | null) {
  let now = 0;
  const callbacks: (() => void)[] = [];
  const telemetry = new FrameTelemetry({
    now: () => now,
    requestFrame: (cb) => {
      callbacks.push(cb);
      return callbacks.length;
    },
    cancelFrame: () => {
      callbacks.length = 0;
    },
    performanceObserver: observer,
    devicePixelRatio: () => 2,
    ringCapacity: 8,
  });
  /** Advance the clock and fire the next pending frame callback. */
  const pumpFrame = (dtMs: number): void => {
    now += dtMs;
    const cb = callbacks.shift();
    cb?.();
  };
  return { telemetry, pumpFrame, pending: () => callbacks.length };
}

describe('FrameTelemetry — zero overhead when closed', () => {
  beforeEach(() => MockObserver.reset());

  it('constructing the collector registers NOTHING', () => {
    const { telemetry, pending } = makeHarness(MockObserver);
    expect(MockObserver.instances).toBe(0);
    expect(pending()).toBe(0); // no rAF scheduled
    expect(telemetry.running).toBe(false);
    expect(telemetry.snapshot()).toBeNull();
  });

  it('start() registers exactly one observer and one frame callback', () => {
    const { telemetry, pending } = makeHarness(MockObserver);
    telemetry.start();
    expect(MockObserver.instances).toBe(1);
    expect(MockObserver.observeCalls).toBe(1);
    expect(pending()).toBe(1);
    telemetry.start(); // idempotent
    expect(MockObserver.instances).toBe(1);
    telemetry.stop();
  });

  it('stop() disconnects the observer, cancels the loop, drops the ring', () => {
    const { telemetry, pumpFrame, pending } = makeHarness(MockObserver);
    telemetry.start();
    pumpFrame(16);
    pumpFrame(16);
    telemetry.stop();
    expect(MockObserver.disconnectCalls).toBe(1);
    expect(pending()).toBe(0);
    expect(telemetry.running).toBe(false);
    expect(telemetry.snapshot()).toBeNull();
    telemetry.stop(); // idempotent
    expect(MockObserver.disconnectCalls).toBe(1);
  });
});

describe('FrameTelemetry — sampling', () => {
  beforeEach(() => MockObserver.reset());

  it('measures frame deltas from consecutive frame callbacks', () => {
    const { telemetry, pumpFrame } = makeHarness(MockObserver);
    telemetry.start();
    pumpFrame(0); // first callback only seeds the timestamp
    for (const dt of [10, 20, 10, 40, 10]) pumpFrame(dt);
    const s = telemetry.snapshot();
    expect(s).not.toBeNull();
    // Window {10,20,10,40,10} sorted {10,10,10,20,40}:
    // p50 rank ceil(2.5)=3 → 10; p95/p99 rank 5 → 40.
    expect(s!.frame.windowCount).toBe(5);
    expect(s!.frame.p50Ms).toBe(10);
    expect(s!.frame.p95Ms).toBe(40);
    expect(s!.frame.maxMs).toBe(40);
    expect(s!.frame.over16_7).toBe(2); // the 20 and the 40
    expect(s!.frame.over33_3).toBe(1); // the 40
    expect(s!.effectiveDpr).toBe(2);
    telemetry.stop();
  });

  it('records the longest observed long task and its count', () => {
    const { telemetry } = makeHarness(MockObserver);
    telemetry.start();
    MockObserver.last!.emit([120, 80]);
    MockObserver.last!.emit([60]);
    const s = telemetry.snapshot();
    expect(s!.longestTaskMs).toBe(120);
    expect(s!.longTaskCount).toBe(3);
    telemetry.stop();
  });

  it('reports longtask as null — never 0 — where unsupported', () => {
    const { telemetry, pumpFrame } = makeHarness(null);
    telemetry.start();
    pumpFrame(0);
    pumpFrame(16);
    const s = telemetry.snapshot();
    expect(s!.longestTaskMs).toBeNull();
    expect(s!.longTaskCount).toBeNull();
    expect(s!.frame.windowCount).toBe(1);
    telemetry.stop();
  });

  it('a restart begins a fresh window and fresh counters', () => {
    const { telemetry, pumpFrame } = makeHarness(MockObserver);
    telemetry.start();
    pumpFrame(0);
    pumpFrame(50);
    telemetry.stop();
    telemetry.start();
    const s = telemetry.snapshot();
    expect(s!.frame.total).toBe(0);
    expect(s!.frame.over33_3).toBe(0);
    telemetry.stop();
  });
});
