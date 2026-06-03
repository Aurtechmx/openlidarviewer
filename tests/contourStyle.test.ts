/**
 * contourStyle.test.ts — index/intermediate classification.
 */

import { describe, it, expect } from 'vitest';
import { styleLevels } from '../src/terrain/contour/contourStyle';

describe('styleLevels', () => {
  it('marks every Nth contour as an index contour anchored to elevation 0', () => {
    const r = styleLevels([0, 1, 2, 3, 4, 5, 10], { intervalM: 1, indexEvery: 5 });
    const byValue = new Map(r.levels.map((l) => [l.value, l]));
    expect(byValue.get(0)!.isIndex).toBe(true);
    expect(byValue.get(5)!.isIndex).toBe(true);
    expect(byValue.get(10)!.isIndex).toBe(true);
    expect(byValue.get(3)!.isIndex).toBe(false);
  });

  it('weights index contours heavier and makes them label-eligible', () => {
    const r = styleLevels([0, 1, 2, 3, 4, 5], { intervalM: 1, indexEvery: 5 });
    const idx = r.levels.find((l) => l.value === 5)!;
    const mid = r.levels.find((l) => l.value === 3)!;
    expect(idx.weight).toBeGreaterThan(mid.weight);
    expect(idx.labelEligible).toBe(true);
    expect(mid.labelEligible).toBe(false);
  });

  it('warns when the level spacing is not a consistent interval', () => {
    const r = styleLevels([0, 1, 3], { intervalM: 1 });
    expect(r.warnings.join(' ')).toMatch(/consistent interval/i);
  });

  it('handles a 2 m interval (index every 5 → 0, 10, 20)', () => {
    const r = styleLevels([0, 2, 4, 6, 8, 10], { intervalM: 2, indexEvery: 5 });
    const byValue = new Map(r.levels.map((l) => [l.value, l]));
    expect(byValue.get(0)!.isIndex).toBe(true);
    expect(byValue.get(10)!.isIndex).toBe(true);
    expect(byValue.get(4)!.isIndex).toBe(false);
  });
});
