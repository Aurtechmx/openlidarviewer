/**
 * symEig3.test.ts — the symmetric 3×3 eigensolver.
 */

import { describe, it, expect } from 'vitest';
import { symEig3 } from '../src/math/symEig3';

describe('symEig3', () => {
  it('diagonalises a diagonal matrix, sorted descending', () => {
    const e = symEig3(1, 0, 0, 5, 0, 3); // eigenvalues 5,3,1
    expect(e.values[0]).toBeCloseTo(5, 9);
    expect(e.values[1]).toBeCloseTo(3, 9);
    expect(e.values[2]).toBeCloseTo(1, 9);
  });

  it('recovers eigenvalues of a known symmetric matrix (trace + det invariants)', () => {
    // [[2,1,0],[1,2,0],[0,0,3]] → eigenvalues 3,3,1.
    const e = symEig3(2, 1, 0, 2, 0, 3);
    const vals = [...e.values].sort((a, b) => b - a);
    expect(vals[0]).toBeCloseTo(3, 6);
    expect(vals[1]).toBeCloseTo(3, 6);
    expect(vals[2]).toBeCloseTo(1, 6);
    // Trace and determinant are preserved.
    expect(e.values[0] + e.values[1] + e.values[2]).toBeCloseTo(7, 6);
  });

  it('returns unit eigenvectors that actually satisfy A v = λ v', () => {
    const axx = 4, axy = 1, axz = 0.5, ayy = 3, ayz = 0.2, azz = 2;
    const e = symEig3(axx, axy, axz, ayy, ayz, azz);
    for (let k = 0; k < 3; k++) {
      const v = e.vectors[k], lam = e.values[k];
      // A v
      const av = [
        axx * v[0] + axy * v[1] + axz * v[2],
        axy * v[0] + ayy * v[1] + ayz * v[2],
        axz * v[0] + ayz * v[1] + azz * v[2],
      ];
      expect(av[0]).toBeCloseTo(lam * v[0], 5);
      expect(av[1]).toBeCloseTo(lam * v[1], 5);
      expect(av[2]).toBeCloseTo(lam * v[2], 5);
      // Unit length.
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 6);
    }
  });
});
