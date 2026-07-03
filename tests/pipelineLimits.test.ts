/**
 * pipelineLimits.test.ts
 *
 * Pins the P8 pipeline policy: device presets, admission gates that respect both
 * the concurrency and byte caps, and — the invariant that matters — adaptation
 * that NEVER raises network concurrency under decode/upload backpressure or
 * elevated failures, rises only slowly when healthy with work waiting, and eases
 * decode down under upload backlog. Plus the EWMA smoother.
 */

import { describe, it, expect } from 'vitest';
import {
  DESKTOP_PIPELINE_LIMITS,
  MOBILE_PIPELINE_LIMITS,
  pipelineLimitsFor,
  canStartFetch,
  canStartDecode,
  decodeOrUploadBackpressured,
  adaptConcurrency,
  smooth,
  RTT_GOOD_MS,
  FAILURE_HIGH,
  MIN_FETCHES,
  type PipelineSignals,
  type PipelineLimits,
} from '../src/render/streaming/pipelineLimits';

const L: PipelineLimits = DESKTOP_PIPELINE_LIMITS;

/** A healthy-network signal set, overridable per test. */
function healthy(overrides: Partial<PipelineSignals> = {}): PipelineSignals {
  return {
    smoothedRttMs: 80,
    throughputBytesPerSec: 8_000_000,
    failureRate: 0,
    fetchQueueDepth: 5,
    decodeUtilization: 0.3,
    uploadBacklogBytes: 0,
    ...overrides,
  };
}

describe('presets', () => {
  it('mobile is more conservative than desktop on every axis', () => {
    expect(MOBILE_PIPELINE_LIMITS.maxConcurrentFetches).toBeLessThan(L.maxConcurrentFetches);
    expect(MOBILE_PIPELINE_LIMITS.maxConcurrentDecodes).toBeLessThanOrEqual(L.maxConcurrentDecodes);
    expect(MOBILE_PIPELINE_LIMITS.maxCompressedQueuedBytes).toBeLessThan(L.maxCompressedQueuedBytes);
    expect(MOBILE_PIPELINE_LIMITS.uploadMsPerFrame).toBeLessThan(L.uploadMsPerFrame);
  });
  it('pipelineLimitsFor picks by device', () => {
    expect(pipelineLimitsFor(true)).toBe(MOBILE_PIPELINE_LIMITS);
    expect(pipelineLimitsFor(false)).toBe(DESKTOP_PIPELINE_LIMITS);
  });
});

describe('admission gates', () => {
  it('canStartFetch respects both the count and the byte cap', () => {
    expect(canStartFetch(L.maxConcurrentFetches - 1, 0, L)).toBe(true);
    expect(canStartFetch(L.maxConcurrentFetches, 0, L)).toBe(false); // at count cap
    expect(canStartFetch(0, L.maxCompressedQueuedBytes, L)).toBe(false); // at byte cap
  });
  it('canStartDecode respects both the count and the byte cap', () => {
    expect(canStartDecode(L.maxConcurrentDecodes - 1, 0, L)).toBe(true);
    expect(canStartDecode(L.maxConcurrentDecodes, 0, L)).toBe(false);
    expect(canStartDecode(0, L.maxDecodedPendingBytes, L)).toBe(false);
  });
});

describe('adaptConcurrency — the backpressure invariant', () => {
  it('never raises fetches when decode is saturated', () => {
    const s = healthy({ decodeUtilization: 0.95 });
    expect(decodeOrUploadBackpressured(s, L)).toBe(true);
    const next = adaptConcurrency({ fetches: 2, decodes: 2 }, s, L);
    expect(next.fetches).toBeLessThanOrEqual(2);
  });
  it('never raises fetches when upload backlog is high', () => {
    const s = healthy({ uploadBacklogBytes: L.maxDecodedPendingBytes });
    const next = adaptConcurrency({ fetches: 2, decodes: 2 }, s, L);
    expect(next.fetches).toBeLessThanOrEqual(2);
    expect(next.decodes).toBeLessThan(2); // upload can't keep up → decode less
  });
  it('eases fetches down on elevated failures', () => {
    const s = healthy({ failureRate: FAILURE_HIGH });
    expect(adaptConcurrency({ fetches: 4, decodes: 2 }, s, L).fetches).toBe(3);
  });
  it('never drops below the fetch floor', () => {
    const s = healthy({ failureRate: 1 });
    expect(adaptConcurrency({ fetches: MIN_FETCHES, decodes: 1 }, s, L).fetches).toBe(MIN_FETCHES);
  });
});

describe('adaptConcurrency — widening when healthy', () => {
  it('raises fetches by at most 1 when healthy with work waiting', () => {
    const next = adaptConcurrency({ fetches: 2, decodes: 2 }, healthy(), L);
    expect(next.fetches).toBe(3);
  });
  it('does not widen without queued work', () => {
    const next = adaptConcurrency({ fetches: 2, decodes: 2 }, healthy({ fetchQueueDepth: 0 }), L);
    expect(next.fetches).toBe(2);
  });
  it('does not widen when RTT is poor', () => {
    const next = adaptConcurrency({ fetches: 2, decodes: 2 }, healthy({ smoothedRttMs: RTT_GOOD_MS * 4 }), L);
    expect(next.fetches).toBe(2);
  });
  it('never exceeds the configured maximum', () => {
    const next = adaptConcurrency(
      { fetches: L.maxConcurrentFetches, decodes: L.maxConcurrentDecodes },
      healthy(),
      L,
    );
    expect(next.fetches).toBe(L.maxConcurrentFetches);
    expect(next.decodes).toBe(L.maxConcurrentDecodes);
  });
});

describe('smooth (EWMA)', () => {
  it('moves toward the sample by alpha', () => {
    expect(smooth(100, 200, 0.5)).toBe(150);
  });
  it('ignores a non-finite sample and seeds from a non-finite previous', () => {
    expect(smooth(120, Number.NaN, 0.5)).toBe(120);
    expect(smooth(Number.NaN, 200, 0.5)).toBe(200);
  });
});
