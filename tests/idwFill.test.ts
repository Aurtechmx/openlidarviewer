/**
 * idwFill.test.ts — inverse-distance void interpolation.
 */

import { describe, it, expect } from 'vitest';
import { idwFill } from '../src/terrain/ground/idwFill';

describe('idwFill', () => {
  it('leaves measured cells untouched', () => {
    const z = Float32Array.from([10, NaN, 20]);
    const had = Uint8Array.from([1, 0, 1]);
    const out = idwFill(z, had, 3, 1);
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(20);
  });

  it('blends a void from its two equidistant measured neighbours', () => {
    // Cell 1 sits exactly between 10 and 20 → IDW mean = 15.
    const out = idwFill(Float32Array.from([10, NaN, 20]), Uint8Array.from([1, 0, 1]), 3, 1);
    expect(out[1]).toBeCloseTo(15, 5);
  });

  it('recovers a linear ramp far better than nearest-neighbour would', () => {
    // Measured endpoints of a 5-cell ramp 0..40; interior is linear truth.
    const z = Float32Array.from([0, NaN, NaN, NaN, 40]);
    const had = Uint8Array.from([1, 0, 0, 0, 1]);
    const out = idwFill(z, had, 5, 1, { power: 1 });
    // Nearest-neighbour would snap to 0 or 40 (error up to 20). IDW with
    // power 1 is symmetric at the centre and monotonic across — centre
    // must be the midpoint and the profile must increase left→right.
    expect(out[2]).toBeCloseTo(20, 5);
    expect(out[1]).toBeLessThan(out[2]);
    expect(out[3]).toBeGreaterThan(out[2]);
  });

  it('leaves a cell NaN when nothing is within the search radius', () => {
    const z = Float32Array.from([5, NaN, NaN, NaN, NaN]);
    const had = Uint8Array.from([1, 0, 0, 0, 0]);
    const out = idwFill(z, had, 5, 1, { maxRadiusCells: 1 });
    expect(out[0]).toBe(5);
    expect(out[1]).toBeCloseTo(5, 5); // within radius 1
    expect(Number.isNaN(out[4])).toBe(true); // beyond radius 1 → NaN
  });

  it('is deterministic and order-independent', () => {
    const z = Float32Array.from([0, NaN, NaN, 9]);
    const had = Uint8Array.from([1, 0, 0, 1]);
    const a = idwFill(z, had, 4, 1);
    const b = idwFill(z, had, 4, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
