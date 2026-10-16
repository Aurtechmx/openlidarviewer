/**
 * terrainAccessP95Quantile.test.ts: the length-weighted route quantile
 * (`weightedQuantile`, used for the p95 grade and cross slope) returns the
 * smallest value whose edges cover at least `q` of the total length, also at
 * an exact boundary where the edge lengths are not exact in binary.
 *
 * With 100 equal √2 edges valued 1..100, edges valued at most 95 cover
 * exactly 95% of the length, so p95 is 95. A plain float running sum lands
 * one ulp short of 0.95 · total there and returned 96.
 */
import { describe, expect, it } from 'vitest';

import { weightedQuantile } from '../src/simulation/terrainAccess/routeDiagnostics';

const VALUES = Array.from({ length: 100 }, (_, k) => k + 1);
const LENGTHS: readonly [string, number][] = [
  ['√2 (diagonal unit cell)', Math.SQRT2],
  ['√5 (diagonal 1×2 cell)', Math.sqrt(5)],
  ['0.1', 0.1],
  ['1 (orthogonal unit cell)', 1],
];

describe('weightedQuantile at an exact boundary', () => {
  for (const [name, length] of LENGTHS) {
    const weights = VALUES.map(() => length);

    it(`100 equal ${name} edges: p95 is the 95th value`, () => {
      expect(weightedQuantile(VALUES, weights, 0.95)).toBe(95);
    });

    it(`100 equal ${name} edges: q = k/100 returns k for every k`, () => {
      for (let k = 1; k <= 100; k++) expect(weightedQuantile(VALUES, weights, k / 100)).toBe(k);
    });

    it(`100 equal ${name} edges: a q between boundaries returns the next value (control)`, () => {
      for (let k = 1; k <= 100; k++) expect(weightedQuantile(VALUES, weights, (k - 0.5) / 100)).toBe(k);
      expect(weightedQuantile(VALUES, weights, 0.955)).toBe(96);
    });
  }

  it('the result does not depend on the order the edges are listed in', () => {
    const order = VALUES.map((_, i) => (i * 37) % 100);
    const values = order.map((i) => VALUES[i]);
    const weights = order.map(() => Math.SQRT2);
    expect(weightedQuantile(values, weights, 0.95)).toBe(95);
  });

  it('mixed lengths: a boundary reached exactly by √2 and 1 edges', () => {
    // 10 orthogonal edges (value 1) and 10 diagonal edges (value 2):
    // value ≤ 1 covers 10 / (10 + 10√2) of the length.
    const values = [...Array(10).fill(1), ...Array(10).fill(2)];
    const weights = [...Array(10).fill(1), ...Array(10).fill(Math.SQRT2)];
    const share = 10 / (10 + 10 * Math.SQRT2);
    expect(weightedQuantile(values, weights, share)).toBe(1);
    expect(weightedQuantile(values, weights, share + 1e-6)).toBe(2);
  });

  it('a value that covers clearly less than q is never returned', () => {
    expect(weightedQuantile([0.1, 0.9], [99, 1], 0.95)).toBe(0.1);
    expect(weightedQuantile([0.1, 0.9], [1, 1], 0.95)).toBe(0.9);
    expect(weightedQuantile([0.1, 0.9], [94, 6], 0.95)).toBe(0.9);
    expect(weightedQuantile([], [], 0.95)).toBe(0);
  });
});
