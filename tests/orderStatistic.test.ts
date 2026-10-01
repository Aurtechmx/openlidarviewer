/**
 * orderStatistic.test.ts: `sortedValueAt` returns the value a full
 * `Float64Array.prototype.sort` would place at index k, bit for bit, without
 * sorting. The health check's median and MAD read it, so any drift here would
 * change a reported number.
 */
import { describe, expect, it } from 'vitest';
import { sortedValueAt, medianOf } from '../src/analysis/modules/orderStatistic';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function sortedRef(values: Float64Array, k: number): number {
  return Float64Array.from(values).sort()[k];
}

function medianRef(values: Float64Array): number {
  const s = Float64Array.from(values).sort();
  const n = s.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const same = (a: number, b: number): boolean => Object.is(a, b);

const CASES: Record<string, (r: () => number, n: number) => number> = {
  uniform: (r) => r() * 1000 - 500,
  integers: (r) => Math.floor(r() * 7) - 3,
  constant: () => 4.25,
  ascending: (_r, i) => i,
  descending: (_r, i) => -i,
  zeros: (r) => (r() < 0.5 ? -0 : 0),
  withNaN: (r) => (r() < 0.2 ? NaN : r() * 10 - 5),
  allNaN: () => NaN,
  mixedZeros: (r) => { const u = r(); return u < 0.3 ? -0 : u < 0.6 ? 0 : u < 0.8 ? -1 : 1; },
};

describe('sortedValueAt matches a full sort at every probed index', () => {
  for (const [name, gen] of Object.entries(CASES)) {
    for (const n of [1, 2, 3, 10, 101, 2000]) {
      it(`${name}, n=${n}`, () => {
        const r = lcg(n * 31 + name.length);
        const values = new Float64Array(n);
        for (let i = 0; i < n; i++) values[i] = gen(r, i);
        for (const k of new Set([0, 1, n >> 1, (n >> 1) - 1, n - 2, n - 1].filter((x) => x >= 0 && x < n))) {
          const scratch = Float64Array.from(values);
          expect(same(sortedValueAt(scratch, k), sortedRef(values, k)), `k=${k}`).toBe(true);
        }
        expect(same(medianOf(Float64Array.from(values)), medianRef(values))).toBe(true);
      });
    }
  }

  it('keeps the multiset: the scratch holds the same values after selection', () => {
    const r = lcg(7);
    const values = new Float64Array(500).map(() => Math.round(r() * 50));
    const scratch = Float64Array.from(values);
    medianOf(scratch);
    expect(Array.from(scratch.sort())).toEqual(Array.from(Float64Array.from(values).sort()));
  });

  it('returns 0 for an empty input, as the sort-based median did', () => {
    expect(medianOf(new Float64Array(0))).toBe(0);
  });
});
