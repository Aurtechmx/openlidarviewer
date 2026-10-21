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
  geographicLatitudeRefusal,
  GeographicLatitudeError,
  MAX_GEOGRAPHIC_LATITUDE_DEG,
} from '../src/terrain/ground/horizontalScale';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { computeTerrainCore } from '../src/terrain/contour/analyseContours';

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

  it('is the cosine at the latitude itself, limited only to ±90°', () => {
    expect(cosLatitude(89.9)).toBeCloseTo(Math.cos((89.9 * Math.PI) / 180), 12);
    expect(cosLatitude(90)).toBeCloseTo(0, 12);
    expect(cosLatitude(95)).toBeCloseTo(0, 12);
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

  it('withholds a geographic cell size beyond ±89° instead of substituting another latitude', () => {
    for (const lat of [89.5, 89.9, -89.9, 95]) {
      expect(() => horizontalCellMetresXY(0.001, true, lat)).toThrow(GeographicLatitudeError);
    }
    // Projected frames never consult the latitude.
    expect(horizontalCellMetresXY(2, false, 89.9)).toEqual({ x: 2, y: 2 });
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

/**
 * The local ellipsoidal metric (π/180)·a·cos φ / √(1 − e² sin² φ) on WGS84 is
 * the analytic truth for a degree of longitude. The series must agree with it
 * at the latitude asked, and a grid beyond the supported latitude is refused
 * rather than answered with another latitude's scale.
 */
describe('polar latitudes', () => {
  const A = 6_378_137;
  const E2 = 0.00669437999014;
  const truth = (lat: number): number => {
    const phi = (lat * Math.PI) / 180;
    return ((Math.PI / 180) * A * Math.cos(phi)) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
  };

  it.each([89, -89, 89.5, -89.5, 89.9, -89.9])('the longitude degree at %s° matches the ellipsoid within 0.01 %%', (lat) => {
    expect(Math.abs(metresPerDegreeLongitude(lat) / truth(lat) - 1)).toBeLessThan(1e-4);
  });

  it('a 45° east-west plane at 89° reads 45° through the shipped Horn slope', () => {
    const cell = 0.0001; // degrees
    const { x, y } = horizontalCellMetresXY(cell, true, 89);
    const cols = 9;
    const rows = 9;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = c * x; // rise = run east
    const { slope } = hornSlopeAspect(z, cols, rows, x, y);
    // Slope is rise over run; 45° is a gradient of 1.
    expect((Math.atan(slope[4 * cols + 4]) * 180) / Math.PI).toBeCloseTo(45, 4);
  });

  it.each([89.5, -89.5, 89.9, -89.9])('at %s° the metric derivatives are refused with the reason', (lat) => {
    expect(geographicLatitudeRefusal(lat)).toMatch(/polar projected CRS/);
    expect(() => horizontalCellMetresXY(0.0001, true, lat)).toThrow(/beyond the ±89°/);
    const points = Array.from({ length: 400 }, (_, i) => ({ x: (i % 20) * 0.0001, y: Math.floor(i / 20) * 0.0001, z: i % 20 }));
    expect(() =>
      computeTerrainCore({ points } as never, { cellSizeM: 0.0002, isGeographic: true, latitudeDeg: lat } as never),
    ).toThrow(GeographicLatitudeError);
  });

  it('accepts the boundary itself and unknown latitudes', () => {
    expect(geographicLatitudeRefusal(MAX_GEOGRAPHIC_LATITUDE_DEG)).toBeNull();
    expect(geographicLatitudeRefusal(-MAX_GEOGRAPHIC_LATITUDE_DEG)).toBeNull();
    expect(geographicLatitudeRefusal(null)).toBeNull();
    expect(geographicLatitudeRefusal(Number.NaN)).toBeNull();
  });
});
