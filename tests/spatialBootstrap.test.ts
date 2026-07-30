/**
 * spatialBootstrap.test.ts
 *
 * Exercises the resampling with SYNTHETIC, deterministically generated samples.
 * It proves the resampling behaves as intended; it validates no product and
 * supports no claim.
 *
 * The load-bearing test is `block interval is wider than the naive one`: that
 * gap is the entire reason the module exists, so if it ever stops appearing the
 * block resampling has silently degenerated into per-observation resampling.
 */

import { describe, it, expect } from 'vitest';
import {
  blockBootstrap,
  clusterBootstrap,
  leaveOneSiteOut,
  naiveBootstrap,
  MIN_BLOCKS_FOR_INTERVAL,
  MIN_BOOTSTRAP_ITERATIONS,
  type BlockSample,
  type BootstrapOptions,
} from '../src/validation/spatialBootstrap';

const OPTIONS: BootstrapOptions = { seed: 20260729, iterations: 800, confidence: 0.95 };

/**
 * Strongly correlated input: 20 blocks of 25 observations, where a block's
 * offset dominates and the within-block variation is small. Built from a
 * closed-form expression so the fixture is identical on every machine.
 */
function correlatedSamples(blocks = 20, per = 25): BlockSample[] {
  const out: BlockSample[] = [];
  for (let b = 0; b < blocks; b++) {
    const offset = 10 * Math.sin(b * 1.7);
    for (let i = 0; i < per; i++) {
      out.push({ value: offset + 0.01 * i, blockId: `block-${b}` });
    }
  }
  return out;
}

describe('block resampling versus naive resampling', () => {
  it('block interval is wider than the naive one on correlated input', () => {
    const samples = correlatedSamples();
    const values = samples.map((s) => s.value);

    const naive = naiveBootstrap(values, OPTIONS);
    const block = blockBootstrap(samples, OPTIONS);
    expect(naive.status).toBe('estimated');
    expect(block.status).toBe('estimated');
    if (naive.status !== 'estimated' || block.status !== 'estimated') return;

    // Both describe the same sample and the same statistic.
    expect(naive.n).toBe(500);
    expect(block.n).toBe(500);
    expect(block.blocks).toBe(20);
    expect(naive.blocks).toBeNull();
    expect(block.estimate).toBeCloseTo(naive.estimate, 12);

    // The naive interval counts each of 500 cells as independent information
    // when there are only 20 independent places, so it is far too narrow. The
    // ratio is around sqrt(25); assert a conservative factor of 2 so the test
    // pins the direction without pinning the generator's exact draws.
    expect(block.width).toBeGreaterThan(naive.width * 2);
    expect(block.standardError).toBeGreaterThan(naive.standardError * 2);
  });

  it('the two intervals converge when observations are not correlated', () => {
    // One observation per block: there is no within-block correlation left to
    // account for, so block resampling has nothing extra to widen.
    const samples = correlatedSamples(40, 1);
    const naive = naiveBootstrap(samples.map((s) => s.value), OPTIONS);
    const block = blockBootstrap(samples, OPTIONS);
    if (naive.status !== 'estimated' || block.status !== 'estimated') {
      throw new Error('expected both estimates');
    }
    expect(block.width).toBeCloseTo(naive.width, 6);
  });
});

describe('determinism', () => {
  it('returns identical bounds for the same seed', () => {
    const samples = correlatedSamples();
    const a = blockBootstrap(samples, OPTIONS);
    const b = blockBootstrap(samples, OPTIONS);
    expect(a).toEqual(b);
  });

  it('returns different bounds for a different seed, and echoes the seed used', () => {
    const samples = correlatedSamples();
    const a = blockBootstrap(samples, { ...OPTIONS, seed: 1 });
    const b = blockBootstrap(samples, { ...OPTIONS, seed: 2 });
    if (a.status !== 'estimated' || b.status !== 'estimated') {
      throw new Error('expected both estimates');
    }
    expect(a.seed).toBe(1);
    expect(b.seed).toBe(2);
    expect(a.standardError).not.toBe(b.standardError);
    // Different draws, same underlying uncertainty: the widths stay the same
    // order of magnitude, which is all a percentile endpoint guarantees.
    expect(a.width / b.width).toBeGreaterThan(0.5);
    expect(a.width / b.width).toBeLessThan(2);
  });

  it('brackets the observed estimate', () => {
    const block = blockBootstrap(correlatedSamples(), OPTIONS);
    if (block.status !== 'estimated') throw new Error('expected an estimate');
    expect(block.lower).toBeLessThan(block.estimate);
    expect(block.upper).toBeGreaterThan(block.estimate);
    expect(block.width).toBeCloseTo(block.upper - block.lower, 12);
  });

  it('honours a caller-supplied statistic', () => {
    const samples = correlatedSamples(10, 10);
    const rmse = (values: readonly number[]): number =>
      Math.sqrt(values.reduce((acc, v) => acc + v * v, 0) / values.length);
    const r = blockBootstrap(samples, { ...OPTIONS, statistic: rmse });
    if (r.status !== 'estimated') throw new Error('expected an estimate');
    expect(r.estimate).toBeCloseTo(rmse(samples.map((s) => s.value)), 12);
  });
});

describe('cluster resampling weights every site equally', () => {
  // Two clusters, wildly different sizes: pooling is dominated by the big one,
  // cluster averaging is not.
  const samples: BlockSample[] = [
    ...Array.from({ length: 100 }, () => ({ value: 0, blockId: 'big' })),
    ...Array.from({ length: 4 }, () => ({ value: 10, blockId: 'small' })),
  ];

  it('estimates the site-averaged quantity, not the pooled one', () => {
    const cluster = clusterBootstrap(samples, OPTIONS);
    const block = blockBootstrap(samples, OPTIONS);
    if (cluster.status !== 'estimated' || block.status !== 'estimated') {
      throw new Error('expected both estimates');
    }
    // Pooled mean: 40 / 104. Site-averaged mean: (0 + 10) / 2.
    expect(block.estimate).toBeCloseTo(40 / 104, 12);
    expect(cluster.estimate).toBeCloseTo(5, 12);
    expect(cluster.blocks).toBe(2);
    expect(cluster.method).toBe('cluster');
  });
});

describe('leaveOneSiteOut', () => {
  const samples: BlockSample[] = [
    { value: 1, blockId: 'north' },
    { value: 1, blockId: 'north' },
    { value: 2, blockId: 'middle' },
    { value: 2, blockId: 'middle' },
    { value: 30, blockId: 'outlier' },
    { value: 30, blockId: 'outlier' },
  ];

  it('recomputes the statistic with each site removed and reports no seed', () => {
    const r = leaveOneSiteOut(samples);
    expect(r.status).toBe('estimated');
    if (r.status !== 'estimated') return;
    expect(r.seed).toBeNull();
    expect(r.sites).toBe(3);
    expect(r.n).toBe(6);
    expect(r.estimate).toBeCloseTo(66 / 6, 12);
    expect(r.perSite.map((p) => p.siteId)).toEqual(['middle', 'north', 'outlier']);
    // Dropping the outlier site moves the mean from 11 to 1.5, which is the
    // point: one site carries the pooled figure.
    const withoutOutlier = r.perSite.find((p) => p.siteId === 'outlier');
    expect(withoutOutlier?.statistic).toBeCloseTo(1.5, 12);
    expect(withoutOutlier?.omitted).toBe(2);
    // Omitting middle leaves [1,1,30,30] = 15.5; omitting north leaves 16.
    expect(r.min).toBeCloseTo(1.5, 12);
    expect(r.max).toBeCloseTo(16, 12);
    expect(r.range).toBeCloseTo(14.5, 12);
    expect(r.standardError).toBeGreaterThan(0);
  });

  it('is reproducible without a seed', () => {
    expect(leaveOneSiteOut(samples)).toEqual(leaveOneSiteOut(samples));
  });

  it('refuses a single site', () => {
    const r = leaveOneSiteOut([{ value: 1, blockId: 'only' }, { value: 2, blockId: 'only' }]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('too-few-sites');
    expect(r.seed).toBeNull();
  });

  it('refuses an empty sample', () => {
    const r = leaveOneSiteOut([]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no-samples');
  });

  it('refuses a non-finite observation', () => {
    const r = leaveOneSiteOut([
      { value: 1, blockId: 'a' },
      { value: Number.NaN, blockId: 'b' },
    ]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('non-finite-value');
    expect(r.detail).toContain('site b');
  });
});

describe('bootstrap refusals name the seed', () => {
  const samples = correlatedSamples(4, 4);

  it('refuses a single block rather than returning a zero-width interval', () => {
    const oneBlock: BlockSample[] = [
      { value: 1, blockId: 'only' },
      { value: 2, blockId: 'only' },
      { value: 3, blockId: 'only' },
    ];
    const r = blockBootstrap(oneBlock, OPTIONS);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('too-few-blocks');
    expect(r.detail).toContain(`seed=${OPTIONS.seed}`);
    expect(r.detail).toContain(`${MIN_BLOCKS_FOR_INTERVAL} required`);
  });

  it('refuses a block count below a caller-supplied floor', () => {
    const r = blockBootstrap(samples, { ...OPTIONS, minBlocks: 10 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('too-few-blocks');
    expect(r.detail).toContain('10 required');
  });

  it('refuses an empty sample', () => {
    for (const r of [blockBootstrap([], OPTIONS), naiveBootstrap([], OPTIONS), clusterBootstrap([], OPTIONS)]) {
      expect(r.status).toBe('refused');
      if (r.status !== 'refused') continue;
      expect(r.reason).toBe('no-samples');
      expect(r.detail).toContain(`seed=${OPTIONS.seed}`);
    }
  });

  it('refuses a non-integer or negative seed', () => {
    for (const seed of [-1, 1.5, Number.NaN]) {
      const r = blockBootstrap(samples, { ...OPTIONS, seed });
      expect(r.status).toBe('refused');
      if (r.status !== 'refused') continue;
      expect(r.reason).toBe('invalid-seed');
    }
  });

  it('refuses too few iterations for a percentile interval', () => {
    const r = blockBootstrap(samples, {
      ...OPTIONS,
      iterations: MIN_BOOTSTRAP_ITERATIONS - 1,
    });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-iterations');
    expect(r.detail).toContain(`seed=${OPTIONS.seed}`);
  });

  it('refuses a confidence outside (0, 1)', () => {
    for (const confidence of [0, 1, 95, Number.NaN]) {
      const r = blockBootstrap(samples, { ...OPTIONS, confidence });
      expect(r.status).toBe('refused');
      if (r.status !== 'refused') continue;
      expect(r.reason).toBe('invalid-confidence');
    }
  });

  it('refuses a minBlocks below the arithmetic floor', () => {
    const r = blockBootstrap(samples, { ...OPTIONS, minBlocks: 1 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('invalid-min-blocks');
  });

  it('refuses a non-finite observation', () => {
    const r = blockBootstrap([...samples, { value: Number.POSITIVE_INFINITY, blockId: 'bad' }], OPTIONS);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('non-finite-value');
    expect(r.detail).toContain('block bad');
  });

  it('refuses a statistic that does not return a number', () => {
    const r = blockBootstrap(samples, { ...OPTIONS, statistic: () => Number.NaN });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('non-finite-statistic');
    expect(r.detail).toContain(`seed=${OPTIONS.seed}`);
  });

  it('never consults Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random must not be called: the interval would not be reproducible');
    };
    try {
      const r = blockBootstrap(correlatedSamples(6, 6), OPTIONS);
      expect(r.status).toBe('estimated');
      const c = clusterBootstrap(correlatedSamples(6, 6), OPTIONS);
      expect(c.status).toBe('estimated');
      const n = naiveBootstrap([1, 2, 3, 4, 5], OPTIONS);
      expect(n.status).toBe('estimated');
    } finally {
      Math.random = original;
    }
  });
});
