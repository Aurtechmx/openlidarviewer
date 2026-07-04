/**
 * frameTelemetry.ts
 *
 * Per-frame performance sampling for the `?debug=1` overlay (v0.5.5 P0).
 * While started, it measures the delta between animation frames into a
 * fixed-capacity ring buffer (no allocation per frame), counts frames over
 * the 60 Hz / 30 Hz budgets, and — where the browser supports the
 * `longtask` PerformanceObserver entry type — tracks the longest observed
 * main-thread task.
 *
 * Lifecycle contract (the overlay's honesty requirement): NOTHING is
 * allocated or registered until {@link FrameTelemetry.start} — no ring, no
 * requestAnimationFrame loop, no PerformanceObserver. {@link
 * FrameTelemetry.stop} releases all of it. A session without `?debug=1`
 * never constructs this class at all (it rides the lazy DebugOverlay chunk).
 *
 * Pure logic (ring + percentiles) is exported separately and unit-tested in
 * Node; the browser hooks (rAF, PerformanceObserver, devicePixelRatio) are
 * injectable for the same reason.
 */

/** Percentile summary over the ring's current window. */
export interface FramePercentiles {
  /** Samples currently in the window (≤ ring capacity). */
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/**
 * Nearest-rank percentile over the first `count` entries of an ASCENDING
 * sorted array: the smallest value with at least `p`% of samples ≤ it
 * (index `ceil(p/100 × n) − 1`). Returns 0 for an empty window.
 */
export function percentileSorted(
  sortedAsc: ArrayLike<number>,
  count: number,
  p: number,
): number {
  if (count <= 0) return 0;
  const rank = Math.ceil((p / 100) * count);
  const index = Math.min(count - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

/**
 * A fixed-capacity ring of frame times with allocation-free push. The two
 * scratch buffers used by {@link snapshot} are preallocated too, so a
 * 4 Hz overlay refresh does not churn the GC either.
 */
export class FrameTimeRing {
  private readonly _buf: Float64Array;
  private readonly _scratch: Float64Array;
  private _next = 0;
  private _count = 0;
  private _over16_7 = 0;
  private _over33_3 = 0;
  private _totalFrames = 0;

  constructor(capacity = 240) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error(`FrameTimeRing: capacity must be ≥ 1, got ${capacity}`);
    }
    this._buf = new Float64Array(capacity);
    this._scratch = new Float64Array(capacity);
  }

  /** Record one frame time (ms). O(1), zero allocation. */
  push(frameMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs < 0) return;
    this._buf[this._next] = frameMs;
    this._next = (this._next + 1) % this._buf.length;
    if (this._count < this._buf.length) this._count++;
    this._totalFrames++;
    if (frameMs > 16.7) this._over16_7++;
    if (frameMs > 33.3) this._over33_3++;
  }

  /** Samples currently in the rolling window. */
  get windowCount(): number {
    return this._count;
  }

  /** Cumulative frames recorded since construction/reset. */
  get totalFrames(): number {
    return this._totalFrames;
  }

  /** Cumulative frames over the 60 Hz budget (> 16.7 ms). */
  get framesOver16_7(): number {
    return this._over16_7;
  }

  /** Cumulative frames over the 30 Hz budget (> 33.3 ms). */
  get framesOver33_3(): number {
    return this._over33_3;
  }

  /** p50/p95/p99/max over the current window. Sorts a preallocated scratch. */
  snapshot(): FramePercentiles {
    const n = this._count;
    if (n === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    for (let i = 0; i < n; i++) this._scratch[i] = this._buf[i];
    const window = this._scratch.subarray(0, n);
    window.sort();
    return {
      count: n,
      p50: percentileSorted(window, n, 50),
      p95: percentileSorted(window, n, 95),
      p99: percentileSorted(window, n, 99),
      max: window[n - 1],
    };
  }

  /** Clear the window and every counter. */
  reset(): void {
    this._next = 0;
    this._count = 0;
    this._over16_7 = 0;
    this._over33_3 = 0;
    this._totalFrames = 0;
  }
}

/** The machine-readable telemetry snapshot the overlay exports. */
export interface FrameTelemetrySnapshot {
  /** Milliseconds this collector has been running. */
  sampledForMs: number;
  frame: {
    /** Cumulative frames observed while running. */
    total: number;
    /** Rolling-window percentile stats (window = ring capacity). */
    windowCount: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    /** Cumulative frames over 16.7 ms / 33.3 ms since start. */
    over16_7: number;
    over33_3: number;
  };
  /**
   * Longest main-thread task (ms) observed via the `longtask`
   * PerformanceObserver, with the count of long tasks — or null when the
   * platform does not support the entry type (reported honestly, never 0).
   */
  longestTaskMs: number | null;
  longTaskCount: number | null;
  /** Effective device pixel ratio at snapshot time. */
  effectiveDpr: number;
}

/** Minimal structural type for an injectable PerformanceObserver. */
export interface LongTaskObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}
export type LongTaskObserverCtor = new (
  callback: (list: { getEntries(): { duration: number }[] }) => void,
) => LongTaskObserverLike;

/** Injectable environment hooks — real browser globals by default. */
export interface FrameTelemetryOptions {
  now?: () => number;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  /**
   * PerformanceObserver constructor, or null to force "unsupported".
   * Default: the global PerformanceObserver when present.
   */
  performanceObserver?: LongTaskObserverCtor | null;
  devicePixelRatio?: () => number;
  /** Ring capacity (frames in the rolling percentile window). */
  ringCapacity?: number;
}

/** Feature-detect the supported entry types for `longtask`. */
function longTaskSupported(): boolean {
  const po = (globalThis as { PerformanceObserver?: { supportedEntryTypes?: readonly string[] } })
    .PerformanceObserver;
  return Array.isArray(po?.supportedEntryTypes) && po.supportedEntryTypes.includes('longtask');
}

/**
 * The per-frame collector. Construct once (stores options only), `start()`
 * when the overlay opens, `stop()` when it closes. Idempotent both ways.
 */
export class FrameTelemetry {
  private readonly _now: () => number;
  private readonly _requestFrame: (cb: () => void) => number;
  private readonly _cancelFrame: (handle: number) => void;
  private readonly _observerCtor: LongTaskObserverCtor | null;
  private readonly _dpr: () => number;
  private readonly _ringCapacity: number;

  private _ring: FrameTimeRing | null = null;
  private _observer: LongTaskObserverLike | null = null;
  private _rafHandle: number | null = null;
  private _lastFrameTs: number | null = null;
  private _startedAt = 0;
  private _longestTaskMs = 0;
  private _longTaskCount = 0;
  private _longTaskAvailable = false;

  constructor(options: FrameTelemetryOptions = {}) {
    this._now = options.now ?? (() => performance.now());
    this._requestFrame =
      options.requestFrame ?? ((cb) => requestAnimationFrame(() => cb()));
    this._cancelFrame = options.cancelFrame ?? ((h) => cancelAnimationFrame(h));
    this._observerCtor =
      options.performanceObserver !== undefined
        ? options.performanceObserver
        : longTaskSupported()
          ? ((globalThis as { PerformanceObserver?: LongTaskObserverCtor })
              .PerformanceObserver ?? null)
          : null;
    this._dpr = options.devicePixelRatio ?? (() =>
      typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    this._ringCapacity = options.ringCapacity ?? 240;
  }

  /** Whether the collector is currently sampling. */
  get running(): boolean {
    return this._ring !== null;
  }

  /** Allocate the ring, register the rAF loop and the longtask observer. */
  start(): void {
    if (this._ring) return;
    this._ring = new FrameTimeRing(this._ringCapacity);
    this._startedAt = this._now();
    this._lastFrameTs = null;
    this._longestTaskMs = 0;
    this._longTaskCount = 0;
    this._longTaskAvailable = this._observerCtor !== null;
    if (this._observerCtor) {
      try {
        this._observer = new this._observerCtor((list) => {
          for (const entry of list.getEntries()) {
            this._longTaskCount++;
            if (entry.duration > this._longestTaskMs) {
              this._longestTaskMs = entry.duration;
            }
          }
        });
        this._observer.observe({ type: 'longtask', buffered: false });
      } catch {
        // Entry type rejected at observe() time — report as unsupported.
        this._observer = null;
        this._longTaskAvailable = false;
      }
    }
    const tick = (): void => {
      if (!this._ring) return; // stopped between frames
      const ts = this._now();
      if (this._lastFrameTs !== null) this._ring.push(ts - this._lastFrameTs);
      this._lastFrameTs = ts;
      this._rafHandle = this._requestFrame(tick);
    };
    this._rafHandle = this._requestFrame(tick);
  }

  /** Cancel the loop, disconnect the observer, release the ring. */
  stop(): void {
    if (this._rafHandle !== null) {
      this._cancelFrame(this._rafHandle);
      this._rafHandle = null;
    }
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._ring = null;
    this._lastFrameTs = null;
  }

  /** Current snapshot, or null when not running. */
  snapshot(): FrameTelemetrySnapshot | null {
    if (!this._ring) return null;
    const p = this._ring.snapshot();
    return {
      sampledForMs: this._now() - this._startedAt,
      frame: {
        total: this._ring.totalFrames,
        windowCount: p.count,
        p50Ms: p.p50,
        p95Ms: p.p95,
        p99Ms: p.p99,
        maxMs: p.max,
        over16_7: this._ring.framesOver16_7,
        over33_3: this._ring.framesOver33_3,
      },
      longestTaskMs: this._longTaskAvailable ? this._longestTaskMs : null,
      longTaskCount: this._longTaskAvailable ? this._longTaskCount : null,
      effectiveDpr: this._dpr(),
    };
  }
}
