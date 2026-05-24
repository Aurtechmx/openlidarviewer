import {
  makePrng,
  pickInBucket,
  stratifiedSampleIndices,
  STRIDE_SAMPLE_SEED,
} from '../src/io/strideSample';

// ────────────────────────────────────────────────────────────────────────────
// makePrng — the seeded PRNG
// ────────────────────────────────────────────────────────────────────────────

describe('makePrng', () => {
  test('is deterministic — the same seed yields the same sequence', () => {
    const a = makePrng(42);
    const b = makePrng(42);
    for (let i = 0; i < 200; i++) expect(b()).toBe(a());
  });

  test('every value is in the range [0, 1)', () => {
    const rand = makePrng(STRIDE_SAMPLE_SEED);
    for (let i = 0; i < 2000; i++) {
      const v = rand();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('different seeds yield different sequences', () => {
    const a = makePrng(1);
    const b = makePrng(2);
    let identical = 0;
    for (let i = 0; i < 100; i++) if (a() === b()) identical++;
    expect(identical).toBeLessThan(100);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// stratifiedSampleIndices — one jittered pick per bucket
// ────────────────────────────────────────────────────────────────────────────

describe('stratifiedSampleIndices', () => {
  test('returns ceil(count / step) indices — one per bucket', () => {
    expect(stratifiedSampleIndices(100, 4)).toHaveLength(25);
    expect(stratifiedSampleIndices(101, 4)).toHaveLength(26); // ceil(101 / 4)
    expect(stratifiedSampleIndices(0, 4)).toHaveLength(0);
  });

  test('the b-th index sits inside bucket b and within the record range', () => {
    const count = 1000;
    const step = 7;
    stratifiedSampleIndices(count, step).forEach((value, b) => {
      expect(value).toBeGreaterThanOrEqual(b * step);
      expect(value).toBeLessThan(Math.min(count, (b + 1) * step));
    });
  });

  test('indices are strictly increasing — sorted and unique', () => {
    const idx = stratifiedSampleIndices(1000, 7);
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    }
  });

  test('the sampling is jittered — not a fixed b*step progression', () => {
    const step = 7;
    const idx = stratifiedSampleIndices(1000, step);
    // A plain fixed stride would be exactly [0, 7, 14, …]; this must not be.
    const isPlainStride = idx.every((value, b) => value === b * step);
    expect(isPlainStride).toBe(false);
  });

  test('is deterministic — the same arguments yield the same indices', () => {
    expect(stratifiedSampleIndices(1000, 7)).toEqual(stratifiedSampleIndices(1000, 7));
  });

  test('step 1 selects every record, in order', () => {
    expect(stratifiedSampleIndices(5, 1)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// pickInBucket — one bucket's jittered offset
// ────────────────────────────────────────────────────────────────────────────

describe('pickInBucket', () => {
  test('clamps the last bucket to the final valid record', () => {
    // count 10, step 4 -> buckets 0,1,2; bucket 2 covers [8,12) but only 8,9
    // exist. A maximal jitter must still land on a real record.
    const alwaysHigh = (): number => 0.999;
    expect(pickInBucket(2, 4, 10, alwaysHigh)).toBe(9);
  });

  test('a zero-jitter pick is the bucket start', () => {
    const alwaysZero = (): number => 0;
    expect(pickInBucket(3, 5, 100, alwaysZero)).toBe(15);
  });
});
