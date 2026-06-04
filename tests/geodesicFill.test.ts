/**
 * geodesicFill.test.ts — surface-aware void interpolation. The headline
 * property: a void in a valley next to a ridge fills from the valley floor,
 * not across the ridge (which plain Euclidean IDW wrongly pulls in).
 */

import { describe, it, expect } from 'vitest';
import { geodesicFill } from '../src/terrain/ground/geodesicFill';
import { idwFill } from '../src/terrain/ground/idwFill';

describe('geodesicFill', () => {
  it('fills a simple gap on a flat surface to the surrounding value', () => {
    // 3x3 all measured at 5 except the centre void.
    const z = Float32Array.from([5, 5, 5, 5, NaN, 5, 5, 5, 5]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const out = geodesicFill(z, had, 3, 3, { cellSizeM: 1 });
    expect(out[4]).toBeCloseTo(5, 5);
  });

  it('does not pull a valley void across a ridge (geodesic < Euclidean)', () => {
    // Row0 = ridge top (100), Row1 = valley floor 0 with a centre gap,
    // Row2 = valley floor 0. Euclidean IDW pulls the ridge into the void;
    // the geodesic path must climb the ridge, so it down-weights it.
    const z = Float32Array.from([100, 100, 100, 0, NaN, 0, 0, 0, 0]);
    const had = Uint8Array.from([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const euclid = idwFill(z, had, 3, 3, {});
    const geo = geodesicFill(z, had, 3, 3, { cellSizeM: 1 });
    expect(euclid[4]).toBeGreaterThan(25); // Euclidean is inflated by the ridge
    expect(geo[4]).toBeLessThan(euclid[4]); // geodesic stays nearer the floor
    expect(geo[4]).toBeLessThan(20);
    expect(geo[4]).toBeGreaterThanOrEqual(0);
  });

  it('keeps measured cells verbatim and leaves an all-empty grid NaN', () => {
    const z = Float32Array.from([3, NaN, 7, NaN]);
    const had = Uint8Array.from([1, 0, 1, 0]);
    const out = geodesicFill(z, had, 2, 2, { cellSizeM: 1 });
    expect(out[0]).toBe(3);
    expect(out[2]).toBe(7);
    expect(Number.isFinite(out[1])).toBe(true); // reachable void filled

    const empty = geodesicFill(
      Float32Array.from([NaN, NaN]),
      Uint8Array.from([0, 0]),
      2, 1, {},
    );
    expect(empty.every((v) => Number.isNaN(v))).toBe(true);
  });
});
