/**
 * numerics.test.ts
 *
 * The compensated accumulators must be (a) correct on known inputs, (b) stable
 * where the naive one-pass forms are not — a variance taken over samples far
 * from zero, and a sum of millions of terms. These are the exact conditions the
 * hardening review flagged, driven with concrete Node evidence.
 */

import { describe, it, expect } from 'vitest';
import { WelfordStats, NeumaierSum, neumaierSum } from '../src/process/numerics';

/** The cancellation-prone one-pass variance, kept here only as the foil. */
function naivePopulationVariance(values: number[]): number {
  let sum = 0;
  let sumSq = 0;
  for (const x of values) {
    sum += x;
    sumSq += x * x;
  }
  const n = values.length;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

describe('WelfordStats', () => {
  it('matches the textbook mean and population variance on a small set', () => {
    const w = new WelfordStats();
    for (const x of [2, 4, 4, 4, 5, 5, 7, 9]) w.push(x);
    expect(w.count).toBe(8);
    expect(w.mean).toBeCloseTo(5, 12);
    expect(w.populationVariance).toBeCloseTo(4, 12);
    expect(w.populationStd).toBeCloseTo(2, 12);
    // Sample variance (÷N−1) = 32/7.
    expect(w.sampleVariance).toBeCloseTo(32 / 7, 12);
  });

  it('is order-independent (streaming a permutation gives the same variance)', () => {
    const forward = new WelfordStats();
    const backward = new WelfordStats();
    const xs = Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 10 + i * 0.01);
    for (const x of xs) forward.push(x);
    for (const x of [...xs].reverse()) backward.push(x);
    expect(forward.mean).toBeCloseTo(backward.mean, 9);
    expect(forward.populationVariance).toBeCloseTo(backward.populationVariance, 9);
  });

  it('stays accurate where the naive one-pass form cancels — spread tiny vs a huge offset', () => {
    // 1e8 ± 1: the true population variance is 1. The naive Σx²/n − mean² form
    // subtracts two ~1e16 quantities and loses almost all precision; Welford
    // does not.
    const values = [1e8 - 1, 1e8, 1e8, 1e8 + 1];
    const w = new WelfordStats();
    for (const x of values) w.push(x);
    // Population variance of {-1,0,0,1} about the mean = 2/4 = 0.5.
    expect(w.populationVariance).toBeCloseTo(0.5, 6);

    // At this offset the naive Σx²/n − mean² collapses to ~0 — it loses the
    // ENTIRE variance (0.5 above the representable floor at 1e16), proving the
    // guard earns its place rather than being cosmetic.
    const naive = naivePopulationVariance(values);
    expect(Math.abs(naive - 0.5)).toBeGreaterThan(0.1);
  });

  it('reports zeros for empty and single-sample inputs', () => {
    const empty = new WelfordStats();
    expect(empty.count).toBe(0);
    expect(empty.mean).toBe(0);
    expect(empty.populationVariance).toBe(0);
    const one = new WelfordStats();
    one.push(42);
    expect(one.mean).toBe(42);
    expect(one.populationVariance).toBe(0);
    expect(one.sampleVariance).toBe(0);
  });
});

describe('neumaierSum / NeumaierSum', () => {
  it('recovers a small term swamped by a large one that a naive sum drops', () => {
    // 1 + 1e100 − 1e100 is 0 in a naive left-to-right sum; the true total is 1.
    expect(neumaierSum([1, 1e100, 1, -1e100])).toBe(2);
  });

  it('sums a million terms with less drift than the naive running sum', () => {
    const n = 1_000_000;
    const term = 0.1; // not exactly representable ⇒ error accumulates
    let naive = 0;
    const acc = new NeumaierSum();
    for (let i = 0; i < n; i++) {
      naive += term;
      acc.add(term);
    }
    const exact = n * term; // 100000
    expect(Math.abs(acc.total - exact)).toBeLessThanOrEqual(Math.abs(naive - exact));
    expect(acc.total).toBeCloseTo(exact, 6);
  });

  it('matches a plain sum on ordinary inputs', () => {
    expect(neumaierSum([1, 2, 3, 4, 5])).toBe(15);
    expect(neumaierSum([])).toBe(0);
  });
});
