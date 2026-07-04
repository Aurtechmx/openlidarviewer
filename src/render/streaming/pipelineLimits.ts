/**
 * pipelineLimits.ts
 *
 * Pure policy for the P8 fetch/decode/upload pipeline separation (program §P8).
 *
 * EVIDENCE GATE (§P8): P8 is explicitly evidence-gated — "proceed only if P0/P7
 * measurements show remaining value; narrow or defer if P7 resolves the observed
 * stalls." This module is therefore the *policy math only*: the concurrency
 * limits, admission gates, and the slow hysteretic adaptation. It is NOT wired
 * into the live scheduler. Wiring waits until on-device profiling (live COPC +
 * real network) shows the P7 upload queue did not already resolve the stalls.
 * Pinning the math now means that, if the evidence supports it, the integration
 * is a lookup rather than new logic invented under pressure.
 *
 * The three stages are limited independently so one slow stage can't let another
 * accumulate unbounded work:
 *   • fetch  — network: concurrent requests + compressed bytes queued.
 *   • decode — worker/WASM: concurrent jobs + decoded-pending-upload bytes.
 *   • upload — main thread: ms/frame (owned by the P7 GpuUploadQueue).
 *
 * The one invariant that matters most (§P8): NEVER raise network concurrency
 * while decode or upload backpressure is high — otherwise a fast network just
 * buries a slow CPU. Framework-free, unit-tested in Node.
 */

/** Independent limits for the three pipeline stages. */
export interface PipelineLimits {
  /** Max concurrent in-flight network fetches. */
  readonly maxConcurrentFetches: number;
  /** Max compressed bytes queued (fetched, awaiting decode). */
  readonly maxCompressedQueuedBytes: number;
  /** Max concurrent decode jobs. */
  readonly maxConcurrentDecodes: number;
  /** Max decoded bytes awaiting GPU upload (shared with the P7 queue's backpressure). */
  readonly maxDecodedPendingBytes: number;
  /** Per-frame GPU upload time budget (ms) — the P7 queue's budget. */
  readonly uploadMsPerFrame: number;
}

/** Desktop starting hypotheses (§P8): 6 fetch / 3 decode, roomier byte caps. */
export const DESKTOP_PIPELINE_LIMITS: PipelineLimits = {
  maxConcurrentFetches: 6,
  maxCompressedQueuedBytes: 16 * 1024 * 1024,
  maxConcurrentDecodes: 3,
  maxDecodedPendingBytes: 48 * 1024 * 1024,
  uploadMsPerFrame: 4,
};

/** Mobile starting hypotheses (§P8): 3 fetch / 2 decode, tighter byte caps. */
export const MOBILE_PIPELINE_LIMITS: PipelineLimits = {
  maxConcurrentFetches: 3,
  maxCompressedQueuedBytes: 6 * 1024 * 1024,
  maxConcurrentDecodes: 2,
  maxDecodedPendingBytes: 16 * 1024 * 1024,
  uploadMsPerFrame: 2,
};

/** Pick the starting limits for a device. */
export function pipelineLimitsFor(isMobile: boolean): PipelineLimits {
  return isMobile ? MOBILE_PIPELINE_LIMITS : DESKTOP_PIPELINE_LIMITS;
}

/** Admission gate: may another fetch start right now? */
export function canStartFetch(
  inFlightFetches: number,
  queuedCompressedBytes: number,
  limits: PipelineLimits,
): boolean {
  return (
    inFlightFetches < limits.maxConcurrentFetches &&
    queuedCompressedBytes < limits.maxCompressedQueuedBytes
  );
}

/** Admission gate: may another decode start right now? */
export function canStartDecode(
  inFlightDecodes: number,
  decodedPendingBytes: number,
  limits: PipelineLimits,
): boolean {
  return (
    inFlightDecodes < limits.maxConcurrentDecodes &&
    decodedPendingBytes < limits.maxDecodedPendingBytes
  );
}

/** Live signals the adaptation reacts to (all smoothed by the caller). */
export interface PipelineSignals {
  /** Smoothed round-trip time in ms. */
  readonly smoothedRttMs: number;
  /** Smoothed throughput in bytes/sec (reserved for future widening rules). */
  readonly throughputBytesPerSec: number;
  /** Recent fetch failure rate in `[0, 1]`. */
  readonly failureRate: number;
  /** How many candidate fetches are waiting to start. */
  readonly fetchQueueDepth: number;
  /** Decode capacity in use in `[0, 1]` (in-flight / max). */
  readonly decodeUtilization: number;
  /** Decoded bytes awaiting upload — the upload backpressure signal. */
  readonly uploadBacklogBytes: number;
}

/** The adjustable concurrency of the two throttled stages. */
export interface ConcurrencyState {
  readonly fetches: number;
  readonly decodes: number;
}

// Adaptation thresholds — deliberately conservative; tuned on-device if P8 ships.
export const RTT_GOOD_MS = 150;
export const FAILURE_LOW = 0.02;
export const FAILURE_HIGH = 0.1;
export const DECODE_UTIL_HIGH = 0.9;
/** Fraction of the decoded-pending cap that counts as upload backpressure. */
export const UPLOAD_BACKLOG_FRACTION = 0.75;
export const MIN_FETCHES = 1;
export const MIN_DECODES = 1;

/**
 * Is decode or upload backpressured? While true, network concurrency must not
 * rise (§P8) — a fast pipe would only deepen a slow CPU's backlog.
 */
export function decodeOrUploadBackpressured(
  signals: PipelineSignals,
  limits: PipelineLimits,
): boolean {
  return (
    signals.decodeUtilization >= DECODE_UTIL_HIGH ||
    signals.uploadBacklogBytes >= limits.maxDecodedPendingBytes * UPLOAD_BACKLOG_FRACTION
  );
}

/**
 * One slow, hysteretic adaptation step. Moves each stage's concurrency by at
 * most ±1 per call (so the caller's cadence sets the ramp rate), honouring the
 * core invariant: fetch concurrency never rises under decode/upload backpressure
 * or elevated failures, and only rises when the network is healthy AND there is
 * queued work to justify it. Decode concurrency eases down under upload backlog.
 */
export function adaptConcurrency(
  state: ConcurrencyState,
  signals: PipelineSignals,
  limits: PipelineLimits,
): ConcurrencyState {
  let fetches = state.fetches;
  let decodes = state.decodes;
  const backpressured = decodeOrUploadBackpressured(signals, limits);

  if (backpressured || signals.failureRate >= FAILURE_HIGH) {
    fetches = Math.max(MIN_FETCHES, fetches - 1); // ease network back
  } else if (
    signals.smoothedRttMs <= RTT_GOOD_MS &&
    signals.failureRate <= FAILURE_LOW &&
    signals.fetchQueueDepth > 0 &&
    fetches < limits.maxConcurrentFetches
  ) {
    fetches = fetches + 1; // healthy + work waiting → widen slowly
  }

  if (signals.uploadBacklogBytes >= limits.maxDecodedPendingBytes) {
    decodes = Math.max(MIN_DECODES, decodes - 1); // upload can't keep up → decode less
  } else if (!backpressured && signals.fetchQueueDepth > 0 && decodes < limits.maxConcurrentDecodes) {
    decodes = decodes + 1;
  }

  return { fetches, decodes };
}

/**
 * Exponential moving average — smooth a noisy sample (RTT, throughput) before
 * feeding the adaptation, so a single slow request can't yank concurrency.
 * `alpha` in `(0, 1]`: higher reacts faster. Non-finite samples are ignored.
 */
export function smooth(previous: number, sample: number, alpha = 0.2): number {
  if (!Number.isFinite(sample)) return previous;
  if (!Number.isFinite(previous)) return sample;
  const a = alpha > 0 && alpha <= 1 ? alpha : 0.2;
  return previous + a * (sample - previous);
}
