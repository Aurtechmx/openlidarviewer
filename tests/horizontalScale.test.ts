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
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
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

  it('geographic: Y uses the WGS84 meridional degree, X the parallel degree, at the grid latitude', () => {
    // Hand-evaluated standard series (metres per degree):
    //   lat: 111132.92 − 559.82 cos 2φ + 1.175 cos 4φ − 0.0023 cos 6φ
    //   lon: 111412.84 cos φ − 93.5 cos 3φ + 0.118 cos 5φ
    // φ = 0:  lat 110 574.2727, lon 111 319.458
    // φ = 60: lat 111 412.2402, lon  55 799.979
    const atEq = horizontalCellMetresXY(0.001, true, 0);
    expect(atEq.y).toBeCloseTo(110.5742727, 6);
    expect(atEq.x).toBeCloseTo(111.319458, 6);

    const at60 = horizontalCellMetresXY(0.001, true, 60);
    expect(at60.y).toBeCloseTo(111.4122402, 6);
    expect(at60.x).toBeCloseTo(55.799979, 6);
    // East–west run is about half the north–south one at 60°.
    expect(at60.x / at60.y).toBeCloseTo(0.5, 2);
  });

  it('clamps a degenerate (≥90°) latitude to a POSITIVE X (89° floor)', () => {
    // The longitude series is clamped at ±89° like cosLatitude: a pole-crossing
    // latitude keeps the E–W scale finite and non-zero instead of dividing
    // derivatives by ~0.
    const polar = horizontalCellMetresXY(0.001, true, 95);
    expect(polar.x).toBeGreaterThan(0);
    expect(polar.x).toBeCloseTo(0.001 * metresPerDegreeLongitude(89), 9);
    // N–S is the polar meridional degree, ≈ 111 694 m.
    expect(polar.y).toBeCloseTo(111.6939173, 6);
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

describe('WGS84 degree lengths', () => {
  it('the mean degree of latitude is the meridian quadrant over 90 (111 132.95 m)', () => {
    expect(METRES_PER_DEGREE).toBeCloseTo(10_001_965.729 / 90, 9);
    expect(METRES_PER_DEGREE).toBeCloseTo(111_132.953, 2);
  });

  it('the meridional degree runs 110 574 m (equator) to 111 694 m (poles)', () => {
    expect(metresPerDegreeLatitude(0)).toBeCloseTo(110_574.27, 1);
    expect(metresPerDegreeLatitude(90)).toBeCloseTo(111_693.92, 1);
    expect(metresPerDegreeLatitude(-90)).toBeCloseTo(111_693.92, 1);
    expect(metresPerDegreeLatitude(45)).toBeCloseTo(111_131.745, 2);
  });

  it('the parallel degree is 111 319.46 m at the equator and ≈ cos φ × that elsewhere', () => {
    expect(metresPerDegreeLongitude(0)).toBeCloseTo(111_319.458, 2);
    expect(metresPerDegreeLongitude(45)).toBeCloseTo(78_846.81, 1);
    expect(metresPerDegreeLongitude(-45)).toBeCloseTo(metresPerDegreeLongitude(45), 9);
  });

  it('an unknown latitude returns the mean degree on both axes', () => {
    for (const lat of [null, undefined, Number.NaN]) {
      expect(metresPerDegreeLatitude(lat)).toBe(METRES_PER_DEGREE);
      expect(metresPerDegreeLongitude(lat)).toBe(METRES_PER_DEGREE);
    }
  });
});
