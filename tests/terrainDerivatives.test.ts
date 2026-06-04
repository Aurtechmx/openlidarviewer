/**
 * terrainDerivatives.test.ts — Horn slope/aspect.
 */

import { describe, it, expect } from 'vitest';
import { hornSlopeAspect, hornSlope } from '../src/terrain/ground/terrainDerivatives';

describe('hornSlopeAspect', () => {
  it('is ~0 on a flat surface', () => {
    const z = new Float32Array(9).fill(10);
    const { slope } = hornSlopeAspect(z, 3, 3, 1);
    for (const s of slope) expect(s).toBeCloseTo(0, 6);
  });

  it('recovers a known constant gradient (plane tilted along +x)', () => {
    // z = 2*x over a 3x3 grid, cell size 1 → dz/dx = 2, slope = 2.
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c;
    const { slope } = hornSlopeAspect(z, 3, 3, 1);
    expect(slope[4]).toBeCloseTo(2, 5); // centre cell
  });

  it('scales slope with cell size', () => {
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c;
    expect(hornSlope(z, 3, 3, 2)[4]).toBeCloseTo(1, 5); // half the slope at 2 m cells
  });

  it('is isotropic: a diagonal ramp reads the same magnitude as an axis ramp', () => {
    const axis = new Float32Array(9);
    const diag = new Float32Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        axis[r * 3 + c] = c; // slope 1 along x
        diag[r * 3 + c] = (r + c) / Math.SQRT2; // slope 1 along the diagonal
      }
    expect(hornSlope(diag, 3, 3, 1)[4]).toBeCloseTo(hornSlope(axis, 3, 3, 1)[4], 5);
  });
});
