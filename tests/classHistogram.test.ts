/**
 * tests/classHistogram.test.ts
 *
 * Coverage for the pure per-class occurrence counter and the
 * incremental merge used while streaming chunks. Counts must cover
 * exactly the codes that appear (absent codes stay absent), float
 * codes are floored and masked to a byte, and merge must sum without
 * mutating either input.
 */

import { describe, it, expect } from 'vitest';
import { countClasses, mergeCounts } from '../src/render/class/classHistogram';

describe('countClasses', () => {
  it('counts only the class codes that appear (Uint8Array)', () => {
    const counts = countClasses(new Uint8Array([2, 2, 6, 2, 6]));
    expect(counts.get(2)).toBe(3);
    expect(counts.get(6)).toBe(2);
  });

  it('an absent class is not present in the map', () => {
    const counts = countClasses(new Uint8Array([2, 2]));
    expect(counts.has(5)).toBe(false);
    expect(counts.get(5)).toBeUndefined();
  });

  it('floors float codes and masks with & 0xff', () => {
    // 2.9 -> 2 ; 257.0 -> 257 & 0xff = 1
    const counts = countClasses(new Float32Array([2.9, 2.1, 257]));
    expect(counts.get(2)).toBe(2);
    expect(counts.get(1)).toBe(1);
  });

  it('handles Uint16Array codes above 255 by masking', () => {
    // 300 & 0xff === 44, so it folds onto the literal 44 -> count 2.
    const counts = countClasses(new Uint16Array([300, 44]));
    expect(300 & 0xff).toBe(44);
    expect(counts.get(44)).toBe(2);
    // A high code that does NOT collide with a present byte.
    const c2 = countClasses(new Uint16Array([257]));
    expect(c2.get(1)).toBe(1);
  });
});

describe('mergeCounts', () => {
  it('sums overlapping and disjoint keys', () => {
    const a = new Map<number, number>([
      [2, 3],
      [6, 1],
    ]);
    const b = new Map<number, number>([
      [6, 4],
      [9, 2],
    ]);
    const merged = mergeCounts(a, b);
    expect(merged.get(2)).toBe(3);
    expect(merged.get(6)).toBe(5);
    expect(merged.get(9)).toBe(2);
  });

  it('does not mutate either input', () => {
    const a = new Map<number, number>([[2, 3]]);
    const b = new Map<number, number>([[2, 4]]);
    mergeCounts(a, b);
    expect(a.get(2)).toBe(3);
    expect(b.get(2)).toBe(4);
  });
});
