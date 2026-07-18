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

  it('zScale converts a native-unit rise so a foot-CRS grid reports the true slope', () => {
    // A plane rising 1 unit per 1 cell of X. If the cell size is expressed in
    // METRES but the rise is in FEET (a state-plane-feet DTM), the raw ratio is
    // feet/metre and reads 1/0.3048 ≈ 3.28× too steep. zScale = 0.3048 (feet→m)
    // restores the true slope. aspect is a direction and must be untouched.
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = c; // rise 1 per cell
    const cellMetres = 1;
    const native = hornSlope(z, 3, 3, cellMetres)[4]; // feet-over-metre, uncorrected
    expect(native).toBeCloseTo(1, 5);
    const feetToM = 0.3048;
    const corrected = hornSlopeAspect(z, 3, 3, cellMetres, cellMetres, feetToM);
    expect(corrected.slope[4]).toBeCloseTo(feetToM, 5); // true rise/run
    // aspect (downslope, +x rise ⇒ points −x ⇒ math angle π) is unchanged by zScale.
    const unscaled = hornSlopeAspect(z, 3, 3, cellMetres, cellMetres, 1);
    expect(corrected.aspect[4]).toBeCloseTo(unscaled.aspect[4], 6);
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

  it('per-axis cell metres: a +x ramp scales with X only, a +y ramp with Y only', () => {
    const xRamp = new Float32Array(9);
    const yRamp = new Float32Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        xRamp[r * 3 + c] = 2 * c; // gradient 2 along east–west
        yRamp[r * 3 + c] = 2 * r; // gradient 2 along north–south
      }
    // dz/dx = 2 / cellMetresX — the Y metres are irrelevant for a pure x-ramp.
    expect(hornSlope(xRamp, 3, 3, 2, 99)[4]).toBeCloseTo(1, 5);
    expect(hornSlope(xRamp, 3, 3, 1, 99)[4]).toBeCloseTo(2, 5);
    // dz/dy = 2 / cellMetresY — the X metres are irrelevant for a pure y-ramp.
    expect(hornSlope(yRamp, 3, 3, 99, 2)[4]).toBeCloseTo(1, 5);
    expect(hornSlope(yRamp, 3, 3, 99, 1)[4]).toBeCloseTo(2, 5);
  });

  it('defaults cellMetresY to cellMetresX (backward compatible with the scalar form)', () => {
    const z = new Float32Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) z[r * 3 + c] = 2 * c + r;
    const scalar = hornSlopeAspect(z, 3, 3, 2);
    const explicit = hornSlopeAspect(z, 3, 3, 2, 2);
    expect(Array.from(scalar.slope)).toEqual(Array.from(explicit.slope));
    expect(Array.from(scalar.aspect)).toEqual(Array.from(explicit.aspect));
  });
});
