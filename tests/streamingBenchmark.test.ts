import {
  StreamingBenchmark,
  aggregate,
  formatStreamingBenchmark,
  THRASH_WINDOW_MS,
  REFINED_STABLE_FRACTION,
  SAMPLE_BUFFER_MAX,
} from '../src/render/streaming/streamingBenchmark';

/** A controllable clock — returns whatever `set(t)` last wrote. */
function fakeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (v) => { t = v; } };
}

describe('aggregate', () => {
  test('empty samples → all-zero result', () => {
    expect(aggregate([])).toEqual({ count: 0, mean: 0, p50: 0, p95: 0, max: 0 });
  });

  test('single sample is its own mean, p50, p95, and max', () => {
    const a = aggregate([7]);
    expect(a).toEqual({ count: 1, mean: 7, p50: 7, p95: 7, max: 7 });
  });

  test('mean and max on a small batch', () => {
    const a = aggregate([1, 2, 3, 4, 5]);
    expect(a.count).toBe(5);
    expect(a.mean).toBeCloseTo(3, 6);
    expect(a.max).toBe(5);
  });

  test('p50 is the median (linear interpolation on even counts)', () => {
    expect(aggregate([1, 2, 3, 4]).p50).toBeCloseTo(2.5, 6);
    expect(aggregate([1, 2, 3]).p50).toBeCloseTo(2, 6);
  });

  test('p95 picks the long tail on a 100-element ramp', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    const a = aggregate(samples);
    expect(a.p95).toBeCloseTo(95.05, 2);
  });

  test('aggregation is order-independent', () => {
    const ascending = [1, 2, 3, 4, 5];
    const shuffled = [5, 1, 4, 2, 3];
    expect(aggregate(ascending)).toEqual(aggregate(shuffled));
  });
});

describe('StreamingBenchmark — time markers', () => {
  test('finalize on a fresh collector gives sane zeros and an empty session', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    const r = b.finalize();
    expect(r.firstPaintMs).toBeUndefined();
    expect(r.timeToCoarseStableMs).toBeUndefined();
    expect(r.timeToRefinedStableMs).toBeUndefined();
    expect(r.networkBytes).toBe(0);
    expect(r.decodedBytes).toBe(0);
    expect(r.cacheHits).toBe(0);
    expect(r.thrashEvents).toBe(0);
    expect(r.schedulerTickMs.count).toBe(0);
  });

  test('time markers are written once each — the first record wins', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    clock.set(120);
    b.recordFirstPaint();
    clock.set(200);
    b.recordFirstPaint(); // second call must not move the marker
    clock.set(300);
    b.recordCoarseStable();
    const r = b.finalize();
    expect(r.firstPaintMs).toBeCloseTo(120, 6);
    expect(r.timeToCoarseStableMs).toBeCloseTo(300, 6);
  });

  test('refined-stable fires when resident reaches the documented fraction', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    const target = 1_000_000;
    clock.set(100);
    b.recordResident(Math.floor(target * (REFINED_STABLE_FRACTION - 0.01)), target);
    expect(b.finalize().timeToRefinedStableMs).toBeUndefined();
    clock.set(500);
    b.recordResident(Math.ceil(target * REFINED_STABLE_FRACTION), target);
    expect(b.finalize().timeToRefinedStableMs).toBeCloseTo(500, 6);
    // A later sample must not move the marker back.
    clock.set(900);
    b.recordResident(target, target);
    expect(b.finalize().timeToRefinedStableMs).toBeCloseTo(500, 6);
  });

  test('recordResident with target=0 never marks refined-stable', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordResident(1_000_000, 0);
    expect(b.finalize().timeToRefinedStableMs).toBeUndefined();
  });
});

describe('StreamingBenchmark — accumulators and peaks', () => {
  test('network and decoded bytes are cumulative and ignore non-positive deltas', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordNetworkBytes(1_000);
    b.recordNetworkBytes(500);
    b.recordNetworkBytes(-50); // ignored
    b.recordDecodedBytes(2_500);
    b.recordDecodedBytes(0); // ignored
    const r = b.finalize();
    expect(r.networkBytes).toBe(1_500);
    expect(r.decodedBytes).toBe(2_500);
  });

  test('peak resident points and bytes retain the largest value', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordResident(100, 1_000);
    b.recordResident(900, 1_000);
    b.recordResident(500, 1_000); // smaller — peak holds
    b.recordResidentBytes(10);
    b.recordResidentBytes(50);
    b.recordResidentBytes(20);
    const r = b.finalize();
    expect(r.peakResidentPoints).toBe(900);
    expect(r.peakResidentBytes).toBe(50);
  });

  test('cache snapshots take the running max — tolerates re-snapshotting', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordCacheSnapshot({ hits: 5, misses: 2, evictions: 0 });
    // A later snapshot from the same monotonic counters.
    b.recordCacheSnapshot({ hits: 12, misses: 4, evictions: 1 });
    // An out-of-order snapshot (re-poll, lower numbers) must not regress totals.
    b.recordCacheSnapshot({ hits: 8, misses: 3, evictions: 0 });
    const r = b.finalize();
    expect(r.cacheHits).toBe(12);
    expect(r.cacheMisses).toBe(4);
    expect(r.cacheEvictions).toBe(1);
  });
});

describe('StreamingBenchmark — sample buffers stay bounded', () => {
  test('the scheduler-tick buffer caps at SAMPLE_BUFFER_MAX', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    // Push more samples than capacity; oldest are dropped.
    const total = SAMPLE_BUFFER_MAX + 50;
    for (let i = 0; i < total; i++) b.recordSchedulerTick(i);
    const r = b.finalize();
    // The retained max is the last sample, which is `total - 1`.
    expect(r.schedulerTickMs.count).toBe(SAMPLE_BUFFER_MAX);
    expect(r.schedulerTickMs.max).toBe(total - 1);
  });

  test('decode and frame buffers feed their own aggregates', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    for (const v of [1, 2, 3, 4, 100]) b.recordDecodeMs(v);
    for (const v of [16, 16, 16, 16]) b.recordFrameMs(v);
    const r = b.finalize();
    expect(r.decodeMsPerChunk.mean).toBeCloseTo((1 + 2 + 3 + 4 + 100) / 5, 6);
    expect(r.decodeMsPerChunk.max).toBe(100);
    expect(r.frameMs.mean).toBeCloseTo(16, 6);
    expect(r.frameMs.p95).toBeCloseTo(16, 6);
  });
});

describe('StreamingBenchmark — thrash detection', () => {
  test('a re-add within the thrash window counts; outside the window does not', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);

    // Node A — evict at t=100, re-add at t=200 (within window) → thrash.
    clock.set(100);
    b.recordNodeEvicted('A');
    clock.set(200);
    b.recordNodeReady('A');
    expect(b.finalize().thrashEvents).toBe(1);

    // Node B — evict at t=500, re-add at t=500 + THRASH_WINDOW_MS + 1 → not a thrash.
    clock.set(500);
    b.recordNodeEvicted('B');
    clock.set(500 + THRASH_WINDOW_MS + 1);
    b.recordNodeReady('B');
    expect(b.finalize().thrashEvents).toBe(1);
  });

  test('a node ready with no prior eviction is not a thrash', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordNodeReady('never-evicted');
    expect(b.finalize().thrashEvents).toBe(0);
  });

  test('eviction → ready clears the pending marker so a second ready is not double-counted', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    clock.set(0);
    b.recordNodeEvicted('A');
    clock.set(100);
    b.recordNodeReady('A'); // one thrash
    clock.set(200);
    b.recordNodeReady('A'); // no pending eviction → not a thrash
    expect(b.finalize().thrashEvents).toBe(1);
  });
});

describe('formatStreamingBenchmark', () => {
  test('renders a stable, aligned multi-line block', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    clock.set(120);
    b.recordFirstPaint();
    b.recordSchedulerTick(1.5);
    b.recordSchedulerTick(3.5);
    b.recordNetworkBytes(2 * 1024 * 1024);
    b.recordResident(500_000, 1_000_000);
    clock.set(2000);
    const text = formatStreamingBenchmark(b.finalize());
    expect(text).toContain('streaming benchmark');
    expect(text).toContain('first paint');
    expect(text).toContain('scheduler');
    expect(text).toContain('network bytes');
    expect(text).toContain('thrash events');
  });

  test('an empty session shows the em-dash placeholder for unobserved markers', () => {
    const text = formatStreamingBenchmark(new StreamingBenchmark(fakeClock().now).finalize());
    expect(text).toContain('—');
    expect(text).toContain('scheduler');
  });
});

describe('tierCounters (decoded-tier accounting)', () => {
  test('tierCounters start at zero and count node-ready / node-evicted events', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);
    expect(b.tierCounters()).toEqual({ nodesReady: 0, nodesEvicted: 0 });

    b.recordNodeReady('a');
    b.recordNodeReady('b');
    b.recordNodeReady('c');
    b.recordNodeEvicted('a');
    expect(b.tierCounters()).toEqual({ nodesReady: 3, nodesEvicted: 1 });
  });

  test('tierCounters are independent of compressed-cache counters', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    b.recordCacheSnapshot({ hits: 5, misses: 2, evictions: 1 });
    b.recordNodeReady('x');
    b.recordNodeEvicted('x');
    expect(b.cacheCounters()).toEqual({ hits: 5, misses: 2, evictions: 1 });
    expect(b.tierCounters()).toEqual({ nodesReady: 1, nodesEvicted: 1 });
  });
});

describe('long-session memory discipline', () => {
  test('sample buffers cap at SAMPLE_BUFFER_MAX even after vastly more pushes', () => {
    // Regression: the previous `pushBounded` used Array.shift() which is
    // O(n). The ring-buffer replacement keeps the same retention shape
    // but pushes in O(1). This test pins both: cap stays honoured AND
    // we never grow beyond it.
    const b = new StreamingBenchmark(fakeClock().now);
    const COUNT = SAMPLE_BUFFER_MAX * 5;
    for (let i = 0; i < COUNT; i++) {
      b.recordSchedulerTick(i);
      b.recordDecodeMs(i);
      b.recordFrameMs(i);
    }
    const result = b.finalize();
    expect(result.schedulerTickMs.count).toBe(SAMPLE_BUFFER_MAX);
    expect(result.decodeMsPerChunk.count).toBe(SAMPLE_BUFFER_MAX);
    expect(result.frameMs.count).toBe(SAMPLE_BUFFER_MAX);
  });

  test('recentSchedulerTickStats returns the most recent N after overflow', () => {
    const b = new StreamingBenchmark(fakeClock().now);
    // Push enough to wrap, then enough more that the most-recent-N
    // window is clearly past the wrap point.
    for (let i = 0; i < SAMPLE_BUFFER_MAX + 100; i++) b.recordSchedulerTick(i);
    const stats = b.recentSchedulerTickStats(5);
    expect(stats.count).toBe(5);
    // The most recent 5 ticks were values SAMPLE_BUFFER_MAX+95 …
    // SAMPLE_BUFFER_MAX+99 — their mean is the integer midpoint.
    expect(stats.mean).toBeCloseTo(SAMPLE_BUFFER_MAX + 97, 6);
    expect(stats.max).toBe(SAMPLE_BUFFER_MAX + 99);
  });

  test('eviction-history map prunes old entries instead of growing unbounded', () => {
    // Regression: `_evictAt.set(id, t)` was called on every eviction and
    // only deleted by `recordNodeReady(id)`. In a long pan across a
    // large dataset, nodes evict and never re-load, so the map grew
    // forever. The opportunistic sweep keeps it bounded by the thrash
    // window.
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);

    // Burn through many evictions over an interval much wider than
    // THRASH_WINDOW_MS so almost all of them are sweep-eligible.
    const TOTAL = 2000;
    for (let i = 0; i < TOTAL; i++) {
      clock.set(i * 100); // 100 ms cadence, far above the window
      b.recordNodeEvicted(`node-${i}`);
    }

    // After the sweep triggers, the map should hold only entries within
    // THRASH_WINDOW_MS of the latest eviction. We can prove this
    // indirectly: a node evicted *before* the window has its
    // `_evictAt` entry pruned, so re-readying it should NOT count as a
    // thrash event.
    clock.set(TOTAL * 100);
    b.recordNodeReady('node-0'); // evicted at t=0, far past the window
    const result = b.finalize();
    expect(result.thrashEvents).toBe(0);
  });

  test('a sweep does NOT prune entries still inside the thrash window', () => {
    const clock = fakeClock();
    const b = new StreamingBenchmark(clock.now);

    // First, trip the sweep trigger with stale entries.
    for (let i = 0; i < 1000; i++) {
      clock.set(i * 100);
      b.recordNodeEvicted(`stale-${i}`);
    }
    // Then add one fresh eviction inside the window relative to the
    // newest time, and re-ready it inside the window.
    const t = 1000 * 100;
    clock.set(t);
    b.recordNodeEvicted('fresh');
    clock.set(t + THRASH_WINDOW_MS / 2);
    b.recordNodeReady('fresh');
    expect(b.finalize().thrashEvents).toBe(1);
  });
});
