/**
 * horizontalScale.test.ts — horizontalCellMetres unit conversion.
 *
 * The cell size arrives in the source horizontal unit. Slope/roughness
 * derivatives divide a metric ΔZ by this run, so it must be turned into real
 * metres: metres-per-degree for a geographic frame, the linear-unit scale for a
 * projected one (1 for metres, ~0.3048 for feet).
 */

import { describe, it, expect } from 'vitest';
import { horizontalCellMetres, METRES_PER_DEGREE } from '../src/terrain/ground/horizontalScale';

describe('horizontalCellMetres', () => {
  it('projected metre data passes through unchanged (default scale)', () => {
    expect(horizontalCellMetres(2)).toBe(2);
    expect(horizontalCellMetres(2, false)).toBe(2);
    expect(horizontalCellMetres(2, false, 1)).toBe(2);
  });

  it('projected feet data scales the run into metres', () => {
    expect(horizontalCellMetres(10, false, 0.3048)).toBeCloseTo(3.048, 6);
  });

  it('a geographic frame converts degrees to metres and ignores the unit scale', () => {
    expect(horizontalCellMetres(0.001, true)).toBeCloseTo(0.001 * METRES_PER_DEGREE, 6);
    // The projected unit scale is irrelevant when the frame is geographic.
    expect(horizontalCellMetres(0.001, true, 0.3048)).toBeCloseTo(0.001 * METRES_PER_DEGREE, 6);
  });

  it('a non-positive or non-finite scale falls back to 1 (no collapse to zero)', () => {
    expect(horizontalCellMetres(5, false, 0)).toBe(5);
    expect(horizontalCellMetres(5, false, Number.NaN)).toBe(5);
    expect(horizontalCellMetres(5, false, -2)).toBe(5);
  });
});
