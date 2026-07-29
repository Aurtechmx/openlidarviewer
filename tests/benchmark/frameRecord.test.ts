/**
 * The plan's rank-2 item is a performance baseline, and its stated rule is
 * that a missing measurement is null, unavailable or not-executed, never zero.
 * A harness that writes 0 for "the browser exposed nothing" asserts a perfect
 * result, and 0 is a legitimate long-task total, so the two become
 * indistinguishable.
 *
 * The other rule is that a comparison names its environment. Frame times from
 * different backends or machines are not a weaker comparison, they are a
 * meaningless one, so the pair is refused rather than reduced to a number.
 */

import { describe, expect, it } from 'vitest';

import {
  compareRuns,
  comparable,
  summarise,
  validateRecord,
  P95_TOLERANCE,
  type FrameRunRecord,
} from '../../benchmarks/performance/frameRecord';

const env = {
  browser: 'Chromium 141',
  os: 'macOS 15',
  architecture: 'arm64',
  backend: 'webgpu' as const,
  adapter: 'Apple M-series',
};

function run(over: Partial<FrameRunRecord> = {}): FrameRunRecord {
  return {
    schemaVersion: 1,
    revision: 'abc1234',
    datasetId: 'synth-copc-small',
    label: 'baseline',
    environment: env,
    coldOrWarm: 'warm',
    frameSamples: [10, 11, 12, 13, 14, 15, 16, 17, 18, 40],
    longTaskMs: null,
    firstRenderMs: null,
    settledMs: null,
    ...over,
  };
}

describe('record validation', () => {
  it('accepts a run with samples and a revision', () => {
    expect(validateRecord(run())).toEqual([]);
  });

  it('refuses a run with no frame samples', () => {
    expect(validateRecord(run({ frameSamples: [] }))).toContain('no-frame-samples');
  });

  it('refuses a zero long-task total claimed with no samples behind it', () => {
    const p = validateRecord(run({ frameSamples: [], longTaskMs: 0 }));
    expect(p).toContain('zero-for-unavailable');
  });

  it('accepts a genuine zero long-task total when frames were measured', () => {
    // Zero is a real reading here, which is exactly why unavailable must be null.
    expect(validateRecord(run({ longTaskMs: 0 }))).toEqual([]);
  });

  it('refuses a negative frame time', () => {
    expect(validateRecord(run({ frameSamples: [10, -1] }))).toContain('negative-frame-sample');
  });
});

describe('summary', () => {
  it('reports percentiles and IQR from the raw samples', () => {
    const s = summarise(run());
    expect(s.samples).toBe(10);
    expect(s.p50).toBe(14);
    expect(s.p95).toBe(40);
    // The outlier moves p95 but not the median, which is the point of both.
    expect(s.iqr).toBeGreaterThan(0);
  });
});

describe('comparability', () => {
  it('refuses a cross-backend pair', () => {
    const a = run();
    const b = run({ environment: { ...env, backend: 'webgl2' } });
    expect(comparable(a, b)).toBe(false);
    expect(compareRuns(a, b).status).toBe('incomparable');
  });

  it('refuses a cold-versus-warm pair', () => {
    expect(comparable(run({ coldOrWarm: 'cold' }), run())).toBe(false);
  });

  it('refuses a cross-dataset pair', () => {
    expect(comparable(run(), run({ datasetId: 'other' }))).toBe(false);
  });
});

describe('comparison', () => {
  const flat = (v: number) => Array.from({ length: 20 }, () => v);

  it('calls a small move unchanged', () => {
    const r = compareRuns(run({ frameSamples: flat(10) }), run({ frameSamples: flat(10.4) }));
    expect(r.status).toBe('unchanged');
    expect(Math.abs(r.p95DeltaPct ?? 1)).toBeLessThanOrEqual(P95_TOLERANCE);
  });

  it('calls a clear rise a regression', () => {
    const r = compareRuns(run({ frameSamples: flat(10) }), run({ frameSamples: flat(14) }));
    expect(r.status).toBe('regressed');
    expect(r.p95DeltaMs).toBeCloseTo(4);
  });

  it('calls a clear fall an improvement', () => {
    expect(compareRuns(run({ frameSamples: flat(20) }), run({ frameSamples: flat(10) })).status)
      .toBe('improved');
  });

  it('refuses to compare an invalid record instead of scoring it', () => {
    const r = compareRuns(run({ frameSamples: [] }), run());
    expect(r.status).toBe('invalid');
    expect(r.p95DeltaMs).toBeUndefined();
  });
});
