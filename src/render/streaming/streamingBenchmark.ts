/**
 * streamingBenchmark.ts
 *
 * Per-session metrics collector for a streaming COPC scan. v0.3.1 hardens
 * the streaming architecture by measuring it — every scheduler / cache /
 * remote optimisation must show a before-and-after through these numbers.
 *
 * The collector is a passive accumulator. It owns no scheduler, no cache,
 * no DOM; the runtime calls its `record*` methods at the right moments
 * (scheduler tick, node ready, node evicted, cache snapshot), and the
 * `finalize()` call produces a structured, comparable result.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** Aggregate stats over a sample buffer — what we care about for tick / decode / frame times. */
export interface AggregateStats {
  /** Number of samples observed (may exceed retained buffer size). */
  count: number;
  /** Arithmetic mean of the retained samples (0 if none). */
  mean: number;
  /** Median (0 if no samples). */
  p50: number;
  /** 95th percentile (0 if no samples). */
  p95: number;
  /** Largest retained sample (0 if none). */
  max: number;
}

/** A finished streaming-session benchmark result, suitable for diff across versions. */
export interface StreamingBenchmarkResult {
  /** ms from session start to the first rendered streaming node, when observed. */
  firstPaintMs: number | undefined;
  /** ms from session start to the coarse view being resident, when observed. */
  timeToCoarseStableMs: number | undefined;
  /**
   * ms from session start to the resident point count first reaching the
   * "refined-stable" threshold (90 % of the target budget), when observed.
   */
  timeToRefinedStableMs: number | undefined;

  /** Total bytes pulled from the range source (compressed). */
  networkBytes: number;
  /** Total bytes of decoded point data produced by the worker. */
  decodedBytes: number;

  /** Scheduler tick wall-time stats. */
  schedulerTickMs: AggregateStats;
  /** Per-chunk decoder wall-time stats. */
  decodeMsPerChunk: AggregateStats;
  /** Frame render wall-time stats, sampled while streaming. */
  frameMs: AggregateStats;

  /** Highest resident point count observed. */
  peakResidentPoints: number;
  /** Highest GPU-estimate byte total observed. */
  peakResidentBytes: number;

  /** Cumulative cache outcomes. */
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;

  /**
   * Count of detected thrash events — a node that was added, evicted, and
   * then re-added within {@link THRASH_WINDOW_MS}.
   */
  thrashEvents: number;

  /** Whole-session wall time, in milliseconds. */
  sessionDurationMs: number;
}

/** Re-add of an evicted node within this window counts as a thrash event. */
export const THRASH_WINDOW_MS = 5_000;

/** A node's resident count must reach this fraction of target to be "refined-stable". */
export const REFINED_STABLE_FRACTION = 0.9;

/** Max samples retained per aggregate buffer — capped so the collector is bounded. */
export const SAMPLE_BUFFER_MAX = 600;

/**
 * Compute aggregate stats over an array of samples. Empty input yields a
 * zeroed result. `count` reflects samples actually retained (which may be
 * smaller than the lifetime total — see {@link SAMPLE_BUFFER_MAX}); the
 * result is otherwise sample-true.
 */
export function aggregate(samples: readonly number[]): AggregateStats {
  if (samples.length === 0) {
    return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  }
  let sum = 0;
  let max = -Infinity;
  for (const s of samples) {
    sum += s;
    if (s > max) max = s;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: samples.length,
    mean: sum / samples.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max,
  };
}

/** Linearly-interpolated percentile on an already-sorted array. */
function percentile(sortedAscending: readonly number[], q: number): number {
  const n = sortedAscending.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAscending[0];
  const clamped = Math.min(1, Math.max(0, q));
  const idx = clamped * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  const frac = idx - lo;
  return sortedAscending[lo] * (1 - frac) + sortedAscending[hi] * frac;
}

/** Monotonic clock — `performance.now()` where available, `Date.now()` otherwise. */
export type Clock = () => number;

const defaultClock: Clock = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * A passive metrics collector for one streaming COPC session.
 *
 * The runtime calls `record*` methods at the right moments — the collector
 * does no introspection of its own. `finalize()` produces the final report.
 */
export class StreamingBenchmark {
  private readonly _clock: Clock;
  private readonly _t0: number;

  private _firstPaintMs: number | undefined;
  private _coarseStableMs: number | undefined;
  private _refinedStableMs: number | undefined;

  private _networkBytes = 0;
  private _decodedBytes = 0;

  private readonly _tickSamples: number[] = [];
  private readonly _decodeSamples: number[] = [];
  private readonly _frameSamples: number[] = [];

  private _peakResidentPoints = 0;
  private _peakResidentBytes = 0;

  private _cacheHits = 0;
  private _cacheMisses = 0;
  private _cacheEvictions = 0;

  /** Last eviction timestamp per node id, for thrash detection. */
  private readonly _evictAt = new Map<string, number>();
  private _thrashEvents = 0;

  // Memory accounting — decoded / GPU tier cumulative counters. The compressed-cache
  // tier already has hits/misses/evictions via cacheCounters(). The decoded
  // and GPU tiers don't have a true cache shape in this architecture
  // (decode → GPU upload is atomic), so the meaningful counters per session
  // are uploads (a node became resident) and evictions (a node left).
  private _nodesReady = 0;
  private _nodesEvicted = 0;

  constructor(clock: Clock = defaultClock) {
    this._clock = clock;
    this._t0 = clock();
  }

  /** Mark the first rendered streaming node — once per session. */
  recordFirstPaint(): void {
    if (this._firstPaintMs === undefined) {
      this._firstPaintMs = this._elapsed();
    }
  }

  /** Mark the moment the coarse view is fully resident — once per session. */
  recordCoarseStable(): void {
    if (this._coarseStableMs === undefined) {
      this._coarseStableMs = this._elapsed();
    }
  }

  /**
   * Sample the resident point count against a target. The first time
   * `resident / target` reaches {@link REFINED_STABLE_FRACTION} or above,
   * the time-to-refined-stable marker is set.
   */
  recordResident(residentPoints: number, targetPoints: number): void {
    if (residentPoints > this._peakResidentPoints) {
      this._peakResidentPoints = residentPoints;
    }
    if (
      this._refinedStableMs === undefined &&
      targetPoints > 0 &&
      residentPoints / targetPoints >= REFINED_STABLE_FRACTION
    ) {
      this._refinedStableMs = this._elapsed();
    }
  }

  /** Sample the GPU-estimate byte total — peaks are retained. */
  recordResidentBytes(bytes: number): void {
    if (bytes > this._peakResidentBytes) this._peakResidentBytes = bytes;
  }

  /** Push one scheduler-tick wall time (ms). */
  recordSchedulerTick(ms: number): void {
    pushBounded(this._tickSamples, ms);
  }

  /** Push one chunk-decode wall time (ms). */
  recordDecodeMs(ms: number): void {
    pushBounded(this._decodeSamples, ms);
  }

  /** Push one frame render wall time (ms), sampled while streaming. */
  recordFrameMs(ms: number): void {
    pushBounded(this._frameSamples, ms);
  }

  /** Add `bytes` to the cumulative network-bytes total. */
  recordNetworkBytes(bytes: number): void {
    if (bytes > 0) this._networkBytes += bytes;
  }

  /** Add `bytes` to the cumulative decoded-bytes total. */
  recordDecodedBytes(bytes: number): void {
    if (bytes > 0) this._decodedBytes += bytes;
  }

  /**
   * Snapshot cumulative cache outcomes. The collector keeps the
   * largest value seen of each, so it tolerates monotonically-growing
   * counters being polled at arbitrary cadence.
   */
  recordCacheSnapshot(snapshot: {
    hits: number;
    misses: number;
    evictions: number;
  }): void {
    if (snapshot.hits > this._cacheHits) this._cacheHits = snapshot.hits;
    if (snapshot.misses > this._cacheMisses) this._cacheMisses = snapshot.misses;
    if (snapshot.evictions > this._cacheEvictions) {
      this._cacheEvictions = snapshot.evictions;
    }
  }

  /**
   * Record a node becoming resident. If the same node was evicted within
   * {@link THRASH_WINDOW_MS}, the event is counted as a thrash and the
   * pending eviction marker is cleared.
   */
  recordNodeReady(nodeId: string): void {
    this._nodesReady += 1;
    const evictedAt = this._evictAt.get(nodeId);
    if (evictedAt !== undefined) {
      this._evictAt.delete(nodeId);
      if (this._elapsed() - evictedAt < THRASH_WINDOW_MS) {
        this._thrashEvents += 1;
      }
    }
  }

  /** Record a node being evicted — start of a potential thrash window. */
  recordNodeEvicted(nodeId: string): void {
    this._nodesEvicted += 1;
    this._evictAt.set(nodeId, this._elapsed());
  }

  /**
   * Memory accounting — decoded / GPU tier cumulative event counts. The compressed
   * tier's hit/miss/evict counters live on {@link cacheCounters}. Decoded
   * and GPU tiers don't have a true cache shape in this architecture
   * (decode → GPU upload is atomic), so the meaningful counters are uploads
   * (a node became resident) and evictions (a node left).
   */
  tierCounters(): {
    nodesReady: number;
    nodesEvicted: number;
  } {
    return {
      nodesReady: this._nodesReady,
      nodesEvicted: this._nodesEvicted,
    };
  }

  /** Live thrash-event count — for the debug overlay. */
  get thrashEvents(): number {
    return this._thrashEvents;
  }

  /** Live cumulative cache outcomes — for the debug overlay. */
  cacheCounters(): { hits: number; misses: number; evictions: number } {
    return {
      hits: this._cacheHits,
      misses: this._cacheMisses,
      evictions: this._cacheEvictions,
    };
  }

  /**
   * Aggregate stats over the most recent `n` scheduler-tick samples
   * (defaults to all retained). Drives the debug overlay's scheduler
   * histogram readout — last 60 by default in the UI.
   */
  recentSchedulerTickStats(n: number = SAMPLE_BUFFER_MAX): AggregateStats {
    const take = Math.min(Math.max(0, n), this._tickSamples.length);
    if (take === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
    return aggregate(this._tickSamples.slice(-take));
  }

  /** Build the final structured result. The collector remains usable afterwards. */
  finalize(): StreamingBenchmarkResult {
    return {
      firstPaintMs: this._firstPaintMs,
      timeToCoarseStableMs: this._coarseStableMs,
      timeToRefinedStableMs: this._refinedStableMs,
      networkBytes: this._networkBytes,
      decodedBytes: this._decodedBytes,
      schedulerTickMs: aggregate(this._tickSamples),
      decodeMsPerChunk: aggregate(this._decodeSamples),
      frameMs: aggregate(this._frameSamples),
      peakResidentPoints: this._peakResidentPoints,
      peakResidentBytes: this._peakResidentBytes,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheEvictions: this._cacheEvictions,
      thrashEvents: this._thrashEvents,
      sessionDurationMs: this._elapsed(),
    };
  }

  /** ms since session start. */
  private _elapsed(): number {
    return this._clock() - this._t0;
  }
}

/** Format a streaming benchmark result as an aligned, multi-line console block. */
export function formatStreamingBenchmark(result: StreamingBenchmarkResult): string {
  const lines: string[] = [];
  const ms = (v: number | undefined): string =>
    v === undefined ? '       —' : `${v.toFixed(1).padStart(8)} ms`;
  const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(2)} MB`;
  const ag = (label: string, a: AggregateStats): void => {
    if (a.count === 0) {
      lines.push(`  ${label.padEnd(14)}       —`);
      return;
    }
    lines.push(
      `  ${label.padEnd(14)}` +
        `n=${String(a.count).padStart(4)}` +
        ` mean=${a.mean.toFixed(2).padStart(7)} ms` +
        ` p50=${a.p50.toFixed(2).padStart(7)} ms` +
        ` p95=${a.p95.toFixed(2).padStart(7)} ms` +
        ` max=${a.max.toFixed(2).padStart(7)} ms`,
    );
  };
  lines.push('streaming benchmark');
  lines.push(`  first paint   ${ms(result.firstPaintMs)}`);
  lines.push(`  coarse stable ${ms(result.timeToCoarseStableMs)}`);
  lines.push(`  refined stable${ms(result.timeToRefinedStableMs)}`);
  lines.push(`  network bytes ${mb(result.networkBytes)}`);
  lines.push(`  decoded bytes ${mb(result.decodedBytes)}`);
  ag('scheduler', result.schedulerTickMs);
  ag('decode/chunk', result.decodeMsPerChunk);
  ag('frame', result.frameMs);
  lines.push(
    `  peak resident ${result.peakResidentPoints.toLocaleString('en-US')} points,` +
      ` ${mb(result.peakResidentBytes)} GPU est.`,
  );
  lines.push(
    `  cache         hits=${result.cacheHits} misses=${result.cacheMisses}` +
      ` evictions=${result.cacheEvictions}` +
      (result.cacheHits + result.cacheMisses > 0
        ? ` (hit ratio ${(
            (100 * result.cacheHits) /
            (result.cacheHits + result.cacheMisses)
          ).toFixed(1)}%)`
        : ''),
  );
  lines.push(`  thrash events ${result.thrashEvents}`);
  lines.push(`  session       ${result.sessionDurationMs.toFixed(1)} ms`);
  return lines.join('\n');
}

/** Push a sample, dropping the oldest if the buffer is at capacity. */
function pushBounded(buf: number[], sample: number): void {
  if (buf.length >= SAMPLE_BUFFER_MAX) buf.shift();
  buf.push(sample);
}
