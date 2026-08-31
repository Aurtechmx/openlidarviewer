/**
 * largeCoordinateStress.test.ts — the measurement cores across the full
 * magnitude ladder (§29 hardening).
 *
 * A LiDAR scene can sit anywhere from local metres to ECEF-scale (~6.4e6 m).
 * Float64 has ~15–16 significant digits, so a millimetre at 6.4e6 m is at the
 * edge of representable — precisely where a naive formula silently degrades.
 * This suite exercises that edge and pins that the measurement cores hold at
 * magnitude. Both are robust for the same underlying reason — the large offset
 * cancels before it can pollute the result: `distance` subtracts the two
 * coordinates first, and the shoelace area's offset contribution,
 * Σ 2·off·(y[j]-y[i]), telescopes to zero around a closed ring. Verified across
 * the ladder up to 1e9 rather than assumed, alongside the degenerate and
 * pathological polygon cases that must stay finite.
 *
 * Pure: the cores only. No DOM, no three.js, no frame plumbing.
 */

import { describe, it, expect } from 'vitest';
import { distance } from '../src/render/measure/geometry';
import { polygonHorizontalArea } from '../src/render/measure/volume';
import { signedArea2D } from '../src/render/measure/polygonHygiene';
import type { Vec3 } from '../src/render/navMath';

/** The offset ladder: origin → survey → continental → ECEF → beyond. */
const OFFSETS = [0, 1e3, 1e6, 6.371e6, 1e7];
/** The delta ladder: metre → centimetre → millimetre. */
const DELTAS = [1, 0.01, 0.001];

describe('distance is precision-safe across the magnitude ladder', () => {
  it('recovers a small separation exactly at every offset, because it subtracts first', () => {
    for (const off of OFFSETS) {
      for (const d of DELTAS) {
        const a: Vec3 = [off, off, off];
        const b: Vec3 = [off + d, off, off];
        // The subtraction cancels the offset in Float64 before the length, so
        // the result is the delta to a tiny fraction of a millimetre even at
        // ECEF magnitude.
        expect(Math.abs(distance(a, b) - d)).toBeLessThan(1e-6);
      }
    }
  });

  it('recovers a 3-4-5 triangle hypotenuse at ECEF magnitude', () => {
    const off = 6.371e6;
    const a: Vec3 = [off, off, off];
    const b: Vec3 = [off + 3, off + 4, off];
    expect(Math.abs(distance(a, b) - 5)).toBeLessThan(1e-6);
  });
});

describe('polygon area near the origin (the operating envelope)', () => {
  const unitSquare = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it('is exact for a unit square recentred at the origin', () => {
    expect(polygonHorizontalArea(unitSquare)).toBeCloseTo(1, 9);
    expect(Math.abs(signedArea2D(unitSquare))).toBeCloseTo(1, 9);
  });

  it('stays exact when translated across the full magnitude ladder', () => {
    // The shoelace sums (x[j]+x[i]), a coordinate SUM — but the offset it adds,
    // Σ 2·off·(y[j]-y[i]), telescopes to zero around a closed ring, so the large
    // terms cancel and the area survives even at ECEF scale and beyond. This is
    // a genuine robustness of the estimator, verified here rather than assumed.
    for (const off of [...OFFSETS, 1e9]) {
      const shifted = unitSquare.map((p) => ({ x: p.x + off, y: p.y + off }));
      expect(Math.abs(polygonHorizontalArea(shifted) - 1)).toBeLessThan(1e-6);
    }
  });
});

describe('degenerate and pathological polygons stay finite', () => {
  it('collinear vertices have zero area', () => {
    const collinear = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    expect(polygonHorizontalArea(collinear)).toBeCloseTo(0, 9);
    expect(signedArea2D(collinear)).toBeCloseTo(0, 9);
  });

  it('repeated vertices do not produce NaN', () => {
    const repeated = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(Number.isFinite(polygonHorizontalArea(repeated))).toBe(true);
    expect(polygonHorizontalArea(repeated)).toBe(0);
  });

  it('a near-degenerate sliver has a tiny but finite positive area', () => {
    const sliver = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1e-6 },
    ];
    const a = polygonHorizontalArea(sliver);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1e-5);
  });

  it('a non-finite vertex yields 0, not NaN (fail-closed, not fail-mysterious)', () => {
    const bad = [
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(signedArea2D(bad)).toBe(0);
  });

  it('fewer than three vertices is zero area, not an error', () => {
    expect(polygonHorizontalArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(0);
    expect(signedArea2D([{ x: 0, y: 0 }])).toBe(0);
  });
});
