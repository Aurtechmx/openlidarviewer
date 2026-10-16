import { describe, expect, test } from 'vitest';
import { symEig3 } from '../src/math/symEig3';
import { objectMetrics } from '../src/terrain/objectMetrics';

/**
 * Both Jacobi eigensolvers stop on an off-diagonal that is negligible
 * relative to the matrix's own diagonal, not below an absolute floor that a
 * small-scale covariance starts under.
 */

/** A rotation about a fixed oblique axis, as a 3×3 matrix. */
function rotation(): number[][] {
  const [x, y, z] = [1, 1, 0.2];
  const n = Math.hypot(x, y, z), ux = x / n, uy = y / n, uz = z / n;
  const a = 0.9, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [
    [c + ux * ux * C, ux * uy * C - uz * s, ux * uz * C + uy * s],
    [uy * ux * C + uz * s, c + uy * uy * C, uy * uz * C - ux * s],
    [uz * ux * C - uy * s, uz * uy * C + ux * s, c + uz * uz * C],
  ];
}

/** R · diag(d) · Rᵀ. */
function rotated(d: readonly number[]): number[][] {
  const R = rotation();
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => R[i][0] * d[0] * R[j][0] + R[i][1] * d[1] * R[j][1] + R[i][2] * d[2] * R[j][2]));
}

describe('symEig3 at any scale', () => {
  test.each([1e-14, 1e-10, 1, 1e6])('recovers 5, 2, 0.5 times %s', (scale) => {
    const d = [5 * scale, 2 * scale, 0.5 * scale];
    const A = rotated(d);
    const e = symEig3(A[0][0], A[0][1], A[0][2], A[1][1], A[1][2], A[2][2]);
    for (let k = 0; k < 3; k++) expect(e.values[k] / d[k]).toBeCloseTo(1, 9);
    // The normal (smallest-eigenvalue vector) is the third rotation column.
    const R = rotation();
    const v = e.vectors[2];
    expect(Math.abs(v[0] * R[0][2] + v[1] * R[1][2] + v[2] * R[2][2])).toBeCloseTo(1, 9);
  });

  test('the zero matrix returns zeros without iterating', () => {
    const e = symEig3(0, 0, 0, 0, 0, 0);
    expect(e.values).toEqual([0, 0, 0]);
  });
});

describe('objectMetrics oriented box at a small scale', () => {
  /** A 4 × 2 × 1 box on a 0.25 grid, rotated 30° about Z, scaled by `k`. */
  function box(k: number): Float64Array {
    const out: number[] = [];
    const a = Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
    for (let x = 0; x <= 4; x += 0.25) for (let y = 0; y <= 2; y += 0.25) for (let z = 0; z <= 1; z += 0.25) {
      out.push(k * (x * c - y * s), k * (x * s + y * c), k * z);
    }
    return Float64Array.from(out);
  }

  test.each([1e-7, 1])('the oriented extents scale with the box (k = %s)', (k) => {
    const m = objectMetrics(Array.from(box(k)));
    expect(m.obb.lengthM / k).toBeCloseTo(4, 6);
    expect(m.obb.widthM / k).toBeCloseTo(2, 6);
    expect(m.obb.heightM / k).toBeCloseTo(1, 6);
  });
});
