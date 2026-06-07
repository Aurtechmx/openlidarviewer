/**
 * tests/classVisibility.test.ts
 *
 * Coverage for the pure 256-entry ASPRS class-visibility state. The
 * 256-wide invariant is load-bearing: extended LAS (PDRF >= 6) keeps
 * the full class byte (0-255), so a 32-wide mask would silently drop
 * high class codes. These tests pin that width plus the isolate /
 * showAll / mask-export behaviour the GPU and UI layers depend on.
 */

import { describe, it, expect } from 'vitest';
import { ClassVisibility } from '../src/render/class/classVisibility';

describe('ClassVisibility', () => {
  it('defaults to all-visible, including high codes (proves 256-wide)', () => {
    const v = new ClassVisibility();
    expect(v.isVisible(0)).toBe(true);
    expect(v.isVisible(2)).toBe(true);
    expect(v.isVisible(64)).toBe(true);
    expect(v.isVisible(255)).toBe(true);
    expect(v.isFiltered()).toBe(false);
  });

  it('setVisible(code,false) hides one class and marks filtered', () => {
    const v = new ClassVisibility();
    v.setVisible(7, false);
    expect(v.isVisible(7)).toBe(false);
    expect(v.isVisible(2)).toBe(true);
    expect(v.isFiltered()).toBe(true);
    v.setVisible(7, true);
    expect(v.isVisible(7)).toBe(true);
    expect(v.isFiltered()).toBe(false);
  });

  it('isolate(2) shows only 2 and hides everything else (incl. 6)', () => {
    const v = new ClassVisibility();
    v.isolate(2);
    expect(v.isVisible(2)).toBe(true);
    expect(v.isVisible(6)).toBe(false);
    expect(v.isFiltered()).toBe(true);
  });

  it('after isolate(2), a not-yet-referenced code (200) is hidden', () => {
    // A later-discovered class must stay hidden under isolate.
    const v = new ClassVisibility();
    v.isolate(2);
    expect(v.isVisible(200)).toBe(false);
  });

  it('showAll resets to fully visible', () => {
    const v = new ClassVisibility();
    v.isolate(2);
    v.showAll();
    expect(v.isVisible(2)).toBe(true);
    expect(v.isVisible(6)).toBe(true);
    expect(v.isVisible(200)).toBe(true);
    expect(v.isFiltered()).toBe(false);
  });

  it('visibleCodes returns hidden-complement in ascending order', () => {
    const v = new ClassVisibility();
    v.setVisible(5, false);
    v.setVisible(1, false);
    const codes = v.visibleCodes();
    expect(codes).toHaveLength(254);
    expect(codes[0]).toBe(0);
    expect(codes).not.toContain(1);
    expect(codes).not.toContain(5);
    // ascending
    for (let i = 1; i < codes.length; i++) {
      expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    }
  });

  it('toMaskArray is length 256 with correct 0/1 entries', () => {
    const v = new ClassVisibility();
    v.setVisible(3, false);
    const mask = v.toMaskArray();
    expect(mask).toBeInstanceOf(Float32Array);
    expect(mask).toHaveLength(256);
    expect(mask[3]).toBe(0);
    expect(mask[2]).toBe(1);
    expect(mask[255]).toBe(1);
  });

  it('masks indices with & 0xff (256 wraps to 0)', () => {
    const v = new ClassVisibility();
    v.setVisible(0, false);
    expect(v.isVisible(256)).toBe(false);
    v.setVisible(257, false); // -> index 1
    expect(v.isVisible(1)).toBe(false);
  });
});
