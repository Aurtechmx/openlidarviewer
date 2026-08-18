/**
 * loaderComparisonRunner.test.ts — the loader suite's judged outcomes.
 *
 * `benchmark:loaders` exercises the happy path against the real competitor, but
 * the branches that make the suite worth having are the ones that FAIL a case: a
 * competitor that reads a LAS 1.4 file it should refuse, or refuses a 1.2 it
 * should read. Those never fire on a healthy run, so they are pinned here with a
 * fake {@link CompetitorProbe} and an injected clock — real OLV decode over a
 * tiny seeded cloud, no loaders.gl, no wall clock, so the test is fast and
 * deterministic.
 */
import { describe, it, expect } from 'vitest';
import {
  runLoaderComparisonSuite,
  type CompetitorProbe,
} from '../../benchmarks/runner/loaderComparison';
import type { LoaderCase, LoaderComparisonConfig } from '../../benchmarks/runner/config';

const READABLE_1_2: LoaderCase = { id: 'las-1.2', lasVersion: '1.2', pointCount: 5000, competitorReadable: true };
const GAP_1_4: LoaderCase = { id: 'las-1.4', lasVersion: '1.4', pointCount: 5000, competitorReadable: false };

function config(cases: LoaderCase[]): LoaderComparisonConfig {
  return {
    suiteId: 'loaderComparison',
    seed: 20260726,
    warmupRuns: 1,
    recordedRuns: 2,
    competitor: { name: 'fake', packageName: 'fake' },
    cases,
  };
}

/** A monotonic clock that advances 1 ms per read, so every duration is 1 ms. */
function fakeClock(): () => bigint {
  let t = 0n;
  return () => (t += 1_000_000n);
}

const reads = (n: number): CompetitorProbe => ({ name: 'fake', version: '9.9.9', decode: async () => n });
const refuses = (message: string): CompetitorProbe => ({
  name: 'fake',
  version: '9.9.9',
  decode: async () => {
    throw new Error(message);
  },
});

describe('loaderComparison runner — judged outcomes', () => {
  it('measures the competitor on a readable case and passes', async () => {
    const r = await runLoaderComparisonSuite(config([READABLE_1_2]), {
      competitor: reads(5000),
      nowNs: fakeClock(),
    });
    expect(r.summary.pass).toBe(true);
    expect(r.summary.competitorVersion).toBe('9.9.9');
    const c = r.summary.cases[0];
    expect(c.competitorStatus).toBe('measured');
    // The speedup series only exists where both loaders ran.
    expect(c.series.available.some((b) => b.key === 'loaderSpeedup')).toBe(true);
    expect(c.series.available.some((b) => b.key === 'competitorLoadMs')).toBe(true);
  });

  it('records the capability gap when the competitor refuses a 1.4 file', async () => {
    const r = await runLoaderComparisonSuite(config([GAP_1_4]), {
      competitor: refuses('Only file versions <= 1.3 are supported'),
      nowNs: fakeClock(),
    });
    expect(r.summary.pass).toBe(true);
    const c = r.summary.cases[0];
    expect(c.competitorStatus).toBe('rejected-as-expected');
    expect(c.competitorRejectionMessage).toMatch(/1\.3/);
    // A gap case has no competitor timing, so those series are unavailable, not zero.
    expect(c.series.available.some((b) => b.key === 'competitorLoadMs')).toBe(false);
    expect(c.series.available.some((b) => b.key === 'olvLoadMs')).toBe(true);
  });

  it('FAILS the suite when the competitor reads a 1.4 file it should refuse', async () => {
    const r = await runLoaderComparisonSuite(config([GAP_1_4]), {
      competitor: reads(5000),
      nowNs: fakeClock(),
    });
    expect(r.summary.pass).toBe(false);
    expect(r.summary.cases[0].status).toBe('failed');
    expect(r.summary.cases[0].competitorStatus).toBe('unexpectedly-read');
    expect(r.summary.failures[0]).toMatch(/read a LAS 1\.4 file/);
  });

  it('FAILS the suite when the competitor throws on a file it should read', async () => {
    const r = await runLoaderComparisonSuite(config([READABLE_1_2]), {
      competitor: refuses('boom'),
      nowNs: fakeClock(),
    });
    expect(r.summary.pass).toBe(false);
    expect(r.summary.cases[0].status).toBe('failed');
    expect(r.summary.cases[0].competitorStatus).toBe('error');
  });

  it('runs OLV-only and records probe-absent when no competitor is injected', async () => {
    const r = await runLoaderComparisonSuite(config([READABLE_1_2, GAP_1_4]), { nowNs: fakeClock() });
    // OLV decodes both files, and a missing competitor is an environment fact, not a failure.
    expect(r.summary.pass).toBe(true);
    expect(r.summary.competitorVersion).toBe('unavailable');
    for (const c of r.summary.cases) {
      expect(c.competitorStatus).toBe('probe-absent');
      expect(c.olvPointCount).toBeGreaterThan(4900);
    }
  });
});
