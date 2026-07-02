/**
 * horizontalScale.test.ts — horizontalCellMetres unit conversion.
 *
 * The cell size arrives in the source horizontal unit. Slope/roughness
 * derivatives divide a metric ΔZ by this run, so it must be turned into real
 * metres: metres-per-degree for a geographic frame, the linear-unit scale for a
 * projected one (1 for metres, ~0.3048 for feet).
 */

import { describe, it, expect } from 'vitest';
import {
  horizontalCellMetres,
  horizontalCellMetresXY,
  cosLatitude,
  METRES_PER_DEGREE,
} from '../src/terrain/ground/horizontalScale';

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

describe('cosLatitude', () => {
  it('hand-computed values: cos 0° = 1, cos 60° = 0.5, sign-symmetric', () => {
    expect(cosLatitude(0)).toBeCloseTo(1, 12);
    expect(cosLatitude(60)).toBeCloseTo(0.5, 12);
    expect(cosLatitude(-60)).toBeCloseTo(0.5, 12);
  });

  it('unknown latitude (null / NaN) means no correction, not a guess', () => {
    expect(cosLatitude(null)).toBe(1);
    expect(cosLatitude(undefined)).toBe(1);
    expect(cosLatitude(Number.NaN)).toBe(1);
  });

  it('clamps beyond ±89° so the E–W scale never collapses to 0', () => {
    // cos(89°) ≈ 0.017452 — the floor for any |lat| ≥ 89, including the pole.
    const floor = Math.cos((89 * Math.PI) / 180);
    expect(cosLatitude(89)).toBeCloseTo(floor, 12);
    expect(cosLatitude(90)).toBeCloseTo(floor, 12);
    expect(cosLatitude(-90)).toBeCloseTo(floor, 12);
  });
});

describe('horizontalCellMetresXY', () => {
  it('projected frames are isotropic (x === y === cellSizeM × scale)', () => {
    expect(horizontalCellMetresXY(2, false)).toEqual({ x: 2, y: 2 });
    const ft = horizontalCellMetresXY(10, false, 0, 0.3048);
    expect(ft.x).toBeCloseTo(3.048, 6);
    expect(ft.y).toBeCloseTo(3.048, 6);
  });

  it('geographic: Y uses metres-per-degree, X shrinks by cos(latitude)', () => {
    const atEq = horizontalCellMetresXY(0.001, true, 0);
    expect(atEq.y).toBeCloseTo(0.001 * METRES_PER_DEGREE, 6);
    expect(atEq.x).toBeCloseTo(atEq.y, 6); // cos 0 = 1

    const at60 = horizontalCellMetresXY(0.001, true, 60);
    expect(at60.y).toBeCloseTo(0.001 * METRES_PER_DEGREE, 6);
    expect(at60.x).toBeCloseTo(at60.y * 0.5, 4); // cos 60° = 0.5 → east–west run halves
  });

  it('clamps a degenerate (≥90°) latitude to a POSITIVE X (cos-89° floor)', () => {
    // The shared cosLatitude clamp: a pole-crossing latitude keeps the E–W
    // scale finite and non-zero instead of dividing derivatives by ~0.
    const polar = horizontalCellMetresXY(0.001, true, 95);
    expect(polar.x).toBeGreaterThan(0);
    expect(polar.x).toBeCloseTo(polar.y * Math.cos((89 * Math.PI) / 180), 9);
  });

  it('an UNKNOWN latitude (null) keeps the isotropic estimate, never NaN', () => {
    // A NaN latitude used to poison the X scale (max(0, cos NaN) = NaN);
    // the shared cosLatitude falls back to cos φ = 1 for both.
    const unknown = horizontalCellMetresXY(0.001, true, null);
    expect(unknown.x).toBeCloseTo(unknown.y, 9);
    const nan = horizontalCellMetresXY(0.001, true, Number.NaN);
    expect(nan.x).toBeCloseTo(nan.y, 9);
    expect(Number.isFinite(nan.x)).toBe(true);
  });
});
