import { describe, it, expect } from 'vitest';
import {
  resolveComparePair,
  CompareRunGuard,
  beginCompareRun,
  COMPARE_NEEDS_TWO,
  COMPARE_SAME_CLOUD,
} from '../src/app/comparePair';
import { compareDtms } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function flat(h: number): DtmGrid {
  const n = 4;
  return {
    z: new Float32Array(n).fill(h),
    confidence: new Float32Array(n).fill(100),
    coverage: new Uint8Array(n).fill(1),
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols: 2,
    rows: 2,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32612',
    verticalDatum: 'EPSG:5703',
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 100,
    warnings: [],
  };
}

describe('resolveComparePair', () => {
  it('defaults to load order when nothing is chosen', () => {
    expect(resolveComparePair(['a', 'b'])).toEqual({ ok: true, beforeId: 'a', afterId: 'b' });
  });

  it('lets the selection override load order, and a swap gives the opposite sign', () => {
    const dtm: Record<string, DtmGrid> = { a: flat(10), b: flat(12) };
    const run = (sel: { before: string; after: string }): number => {
      const r = resolveComparePair(['a', 'b'], sel);
      if (!r.ok) throw new Error(r.message);
      return compareDtms(dtm[r.beforeId], dtm[r.afterId]).result.diff[0];
    };
    const forward = run({ before: 'a', after: 'b' });
    const swapped = run({ before: 'b', after: 'a' });
    expect(forward).toBeCloseTo(2);
    expect(swapped).toBeCloseTo(-2);
  });

  it('picks any two of three or more clouds', () => {
    expect(resolveComparePair(['a', 'b', 'c'], { before: 'a', after: 'c' })).toEqual({ ok: true, beforeId: 'a', afterId: 'c' });
  });

  it('explains what is missing with fewer than two clouds', () => {
    expect(resolveComparePair([])).toEqual({ ok: false, message: COMPARE_NEEDS_TWO });
    expect(resolveComparePair(['a'])).toEqual({ ok: false, message: COMPARE_NEEDS_TWO });
    expect(COMPARE_NEEDS_TWO).toMatch(/Load another scan/);
  });

  it('refuses the same cloud for both', () => {
    expect(resolveComparePair(['a', 'b', 'c'], { before: 'b', after: 'b' })).toEqual({ ok: false, message: COMPARE_SAME_CLOUD });
  });
});

describe('CompareRunGuard', () => {
  it('drops a result once a newer run started', () => {
    const clouds = new Map<string, object>([['a', {}], ['b', {}]]);
    const guard = new CompareRunGuard<object>();
    const first = guard.begin(['a', 'b'], (id) => clouds.get(id));
    const second = guard.begin(['b', 'a'], (id) => clouds.get(id));
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('drops a result when a layer is removed or replaced during the run', () => {
    const clouds = new Map<string, object>([['a', {}], ['b', {}]]);
    const guard = new CompareRunGuard<object>();
    const removed = guard.begin(['a', 'b'], (id) => clouds.get(id));
    clouds.delete('b');
    expect(removed()).toBe(false);
    clouds.set('b', {});
    const replaced = guard.begin(['a', 'b'], (id) => clouds.get(id));
    clouds.set('a', {});
    expect(replaced()).toBe(false);
  });
});

describe('beginCompareRun', () => {
  it('clears the status once when its own cloud is removed mid-run', () => {
    const clouds = new Map<string, object>([['a', {}], ['b', {}]]);
    const guard = new CompareRunGuard<object>();
    let cleared = 0;
    const run = beginCompareRun(guard, ['a', 'b'], { before: null, after: null }, (id) => clouds.get(id), () => { cleared++; });
    if (!run.ok) throw new Error(run.message);
    expect(run.current()).toBe(true);
    clouds.delete('a');
    expect(run.current()).toBe(false);
    expect(run.current()).toBe(false);
    expect(cleared).toBe(1);
  });

  it('leaves the status to a newer run', () => {
    const clouds = new Map<string, object>([['a', {}], ['b', {}]]);
    const guard = new CompareRunGuard<object>();
    let cleared = 0;
    const lookup = (id: string) => clouds.get(id);
    const first = beginCompareRun(guard, ['a', 'b'], { before: null, after: null }, lookup, () => { cleared++; });
    beginCompareRun(guard, ['a', 'b'], { before: 'b', after: 'a' }, lookup, () => { cleared++; });
    if (!first.ok) throw new Error(first.message);
    expect(first.current()).toBe(false);
    expect(cleared).toBe(0);
  });

  it('refuses a bad pair and retires the run in flight', () => {
    const clouds = new Map<string, object>([['a', {}], ['b', {}]]);
    const guard = new CompareRunGuard<object>();
    const lookup = (id: string) => clouds.get(id);
    const first = beginCompareRun(guard, ['a', 'b'], { before: null, after: null }, lookup);
    const refused = beginCompareRun(guard, ['a', 'b'], { before: 'a', after: 'a' }, lookup);
    expect(refused).toEqual({ ok: false, message: COMPARE_SAME_CLOUD });
    if (!first.ok) throw new Error(first.message);
    expect(first.current()).toBe(false);
  });
});
