/**
 * tests/classColor.test.ts
 *
 * The classification legend draws each swatch with `classColor(code)`, the
 * same source the "colour by class" render mode uses, so a swatch always
 * matches the points on screen. This pins that contract: mapped ASPRS codes
 * return their palette entry, unmapped codes fall back to a deterministic hue,
 * the result is a byte-ranged RGB triple, and the code is masked to a byte.
 */

import { describe, it, expect } from 'vitest';
import { classColor } from '../src/render/colorModes';

describe('classColor', () => {
  it('returns the palette entry for mapped ASPRS codes', () => {
    expect(classColor(2)).toEqual([139, 90, 43]); // Ground — brown
    expect(classColor(6)).toEqual([220, 80, 80]); // Building — salmon
    expect(classColor(9)).toEqual([30, 100, 220]); // Water — blue
  });

  it('is deterministic for unmapped codes', () => {
    const a = classColor(200);
    const b = classColor(200);
    expect(a).toEqual(b);
    // A valid byte-ranged RGB triple.
    expect(a).toHaveLength(3);
    for (const c of a) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(255);
      expect(Number.isInteger(c)).toBe(true);
    }
  });

  it('masks the code to a byte (code & 0xff)', () => {
    // 256 wraps to 0, 258 wraps to 2 — same colours as their masked codes.
    expect(classColor(256)).toEqual(classColor(0));
    expect(classColor(258)).toEqual(classColor(2));
  });

  it('returns a fresh array each call (callers may mutate)', () => {
    const a = classColor(2);
    a[0] = 0;
    expect(classColor(2)).toEqual([139, 90, 43]);
  });
});
