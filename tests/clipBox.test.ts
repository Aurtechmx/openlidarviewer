/**
 * clipBox.test.ts
 *
 * Pins the pure clip-region core: enabled/disabled keep-everything, keep-inside
 * vs keep-outside partitioning, inclusive faces, and the mask/count helpers
 * agreeing with the per-point predicate.
 */

import { describe, it, expect } from 'vitest';
import {
  makeClipBox,
  clipKeepsPoint,
  clipMaskArray,
  countKept,
  type ClipBox,
} from '../src/render/clip/clipBox';
import type { BoxBounds } from '../src/render/measure/geometry';

const BOX: BoxBounds = { min: [0, 0, 0], max: [10, 10, 10] };
const inside: [number, number, number] = [5, 5, 5];
const outside: [number, number, number] = [20, 5, 5];

function clip(mode: ClipBox['mode'], enabled = true): ClipBox {
  return { box: BOX, mode, enabled };
}

describe('makeClipBox', () => {
  it('is disabled and keep-inside by default', () => {
    const c = makeClipBox(BOX);
    expect(c.enabled).toBe(false);
    expect(c.mode).toBe('keep-inside');
  });
});

describe('clipKeepsPoint', () => {
  it('a disabled clip keeps every point', () => {
    const c = makeClipBox(BOX);
    expect(clipKeepsPoint(c, inside)).toBe(true);
    expect(clipKeepsPoint(c, outside)).toBe(true);
  });

  it('keep-inside keeps interior, culls exterior', () => {
    const c = clip('keep-inside');
    expect(clipKeepsPoint(c, inside)).toBe(true);
    expect(clipKeepsPoint(c, outside)).toBe(false);
  });

  it('keep-outside inverts the decision', () => {
    const c = clip('keep-outside');
    expect(clipKeepsPoint(c, inside)).toBe(false);
    expect(clipKeepsPoint(c, outside)).toBe(true);
  });

  it('box faces are inclusive', () => {
    const c = clip('keep-inside');
    expect(clipKeepsPoint(c, [0, 0, 0])).toBe(true);
    expect(clipKeepsPoint(c, [10, 10, 10])).toBe(true);
  });
});

describe('clipMaskArray / countKept', () => {
  // four points: two inside (5,5,5),(1,1,1); two outside (20,..),(−1,..).
  const pts = new Float32Array([5, 5, 5, 1, 1, 1, 20, 5, 5, -1, 5, 5]);

  it('disabled → all ones, count = N', () => {
    const c = makeClipBox(BOX);
    expect(Array.from(clipMaskArray(c, pts))).toEqual([1, 1, 1, 1]);
    expect(countKept(c, pts)).toBe(4);
  });

  it('keep-inside masks the two interior points', () => {
    const c = clip('keep-inside');
    expect(Array.from(clipMaskArray(c, pts))).toEqual([1, 1, 0, 0]);
    expect(countKept(c, pts)).toBe(2);
  });

  it('keep-outside masks the two exterior points', () => {
    const c = clip('keep-outside');
    expect(Array.from(clipMaskArray(c, pts))).toEqual([0, 0, 1, 1]);
    expect(countKept(c, pts)).toBe(2);
  });

  it('countKept agrees with the predicate over every point', () => {
    const c = clip('keep-outside');
    let expected = 0;
    for (let i = 0; i < pts.length / 3; i++) {
      if (clipKeepsPoint(c, [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]])) expected++;
    }
    expect(countKept(c, pts)).toBe(expected);
  });
});
