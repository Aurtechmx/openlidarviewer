/**
 * A Web Mercator grid is converted to ground metres with the WGS 84 ground scale
 * at the scan's latitude. The scale is checked against an independent truth,
 * Vincenty's geodesic distance on the ellipsoid between the points a grid step
 * maps to; the terrain run takes the factor, refuses when one factor cannot
 * stand for the whole scan, and leaves every other frame untouched.
 */
import { describe, expect, it } from 'vitest';
import proj4 from 'proj4';
import {
  WEB_MERCATOR_MAX_SCALE_ERROR,
  WEB_MERCATOR_MAX_AREA_ERROR,
  TerrainRefusalError,
  webMercatorGroundScale,
  webMercatorLatitudeOfY,
  webMercatorNote,
  webMercatorRefusal,
  webMercatorScaleBound,
} from '../src/terrain/ground/horizontalScale';
import { deriveCoreParams, webMercatorBoundFor } from '../src/app/terrainAnalysisRunner';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const A = 6_378_137;
const rad = (d: number): number => (d * Math.PI) / 180;
/** EPSG:3857 northing of geodetic latitude `lat`. */
const yOf = (lat: number): number => A * Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2));

/** Vincenty's inverse solution on WGS 84: the geodesic distance in metres. */
function geodesic(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const f = 1 / 298.257223563;
  const b = (1 - f) * A;
  const L = rad(lon2 - lon1);
  const U1 = Math.atan((1 - f) * Math.tan(rad(lat1)));
  const U2 = Math.atan((1 - f) * Math.tan(rad(lat2)));
  const [sU1, cU1, sU2, cU2] = [Math.sin(U1), Math.cos(U1), Math.sin(U2), Math.cos(U2)];
  let lambda = L;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2Alpha = 0, cos2SigmaM = 0;
  for (let i = 0; i < 200; i++) {
    const sL = Math.sin(lambda), cL = Math.cos(lambda);
    sinSigma = Math.hypot(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL);
    if (sinSigma === 0) return 0;
    cosSigma = sU1 * sU2 + cU1 * cU2 * cL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cU1 * cU2 * sL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - (2 * sU1 * sU2) / cos2Alpha : 0;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const prev = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-13) break;
  }
  const u2 = (cos2Alpha * (A * A - b * b)) / (b * b);
  const k1 = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const k2 = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dSigma = k2 * sinSigma * (cos2SigmaM + (k2 / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
    - (k2 / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * k1 * (sigma - dSigma);
}

describe('the Web Mercator ground scale', () => {
  it.each([0, 20, 39.8, 60, 75])('matches the geodesic distance of a 100 m grid step at latitude %s°', (lat) => {
    const step = 100;
    const y0 = yOf(lat);
    const lon0 = 0;
    const east = geodesic(lat, lon0, lat, lon0 + (step / A) * (180 / Math.PI));
    const lat1 = webMercatorLatitudeOfY(y0 + step);
    const north = geodesic(lat, lon0, lat1, lon0);
    const s = webMercatorGroundScale(lat);
    expect(east / step / s.x - 1).toBeCloseTo(0, 5);
    // The northward step spans a range of latitude; its scale is the one at the middle.
    expect(north / step / webMercatorGroundScale((lat + lat1) / 2).y - 1).toBeCloseTo(0, 5);
    expect(s.mean).toBeCloseTo(Math.sqrt(s.x * s.y), 12);
  });

  it('inverts the Web Mercator northing like proj4 does', () => {
    for (const lat of [-60, -10, 0, 25, 39.8, 70]) {
      const [, projLat] = proj4('EPSG:3857', 'EPSG:4326', [0, yOf(lat)]);
      expect(webMercatorLatitudeOfY(yOf(lat))).toBeCloseTo(projLat, 9);
      expect(webMercatorLatitudeOfY(yOf(lat))).toBeCloseTo(lat, 9);
    }
  });

  it('is cos φ-like: about 0.767 at Denver, 1 at the equator, and falling toward the poles', () => {
    expect(webMercatorGroundScale(0).mean).toBeCloseTo(1 - 0.0033, 2);
    expect(webMercatorGroundScale(39.8).mean).toBeGreaterThan(0.76);
    expect(webMercatorGroundScale(39.8).mean).toBeLessThan(0.775);
    expect(webMercatorGroundScale(80).mean).toBeLessThan(0.18);
    // The two axes differ because EPSG:3857 puts the ellipsoid's latitude on a sphere.
    expect(Math.abs(webMercatorGroundScale(40).x - webMercatorGroundScale(40).y)).toBeGreaterThan(0.001);
  });
});

describe('the error one factor leaves, and the refusal beyond it', () => {
  it('a metropolitan extent (0.4° of latitude about Denver) is accepted with a bound near 0.5%', () => {
    const b = webMercatorScaleBound(yOf(39.55), yOf(39.95));
    expect(b.latitudeDeg).toBeCloseTo(39.75, 1);
    expect(b.maxRelativeError).toBeGreaterThan(0.002);
    expect(b.maxRelativeError).toBeLessThan(0.007);
    expect(webMercatorRefusal(b)).toBeNull();
  });

  it('the bound is real: a length measured at the ends is within it of the factor', () => {
    const y0 = yOf(39.55), y1 = yOf(39.95);
    const b = webMercatorScaleBound(y0, y1);
    let seen = 0;
    for (let k = 0; k <= 200; k++) {
      const at = webMercatorGroundScale(webMercatorLatitudeOfY(y0 + ((y1 - y0) * k) / 200));
      // Relative to the true ground figure at that point.
      seen = Math.max(seen, Math.abs(b.groundPerGrid / at.x - 1), Math.abs(b.groundPerGrid / at.y - 1));
    }
    expect(seen).toBeLessThanOrEqual(b.maxRelativeError + 1e-12);
    // And it is tight: the bound is reached at an end, not a loose over-estimate.
    expect(b.maxRelativeError - seen).toBeLessThan(1e-9);
  });

  it('the area bound is real, and it is not the length bound', () => {
    // 59.7 to 60.3 degrees: each length is within about 1%, an area is not.
    const y0 = yOf(59.7), y1 = yOf(60.3);
    const b = webMercatorScaleBound(y0, y1);
    let seen = 0;
    for (let k = 0; k <= 200; k++) {
      const at = webMercatorGroundScale(webMercatorLatitudeOfY(y0 + ((y1 - y0) * k) / 200));
      seen = Math.max(seen, Math.abs((b.groundPerGrid * b.groundPerGrid) / (at.x * at.y) - 1));
    }
    expect(seen).toBeLessThanOrEqual(b.maxRelativeAreaError + 1e-12);
    expect(b.maxRelativeAreaError - seen).toBeLessThan(1e-9);
    // About twice the length error, so a length-only figure would understate it.
    expect(b.maxRelativeAreaError).toBeGreaterThan(1.8 * b.maxRelativeError);
    expect(b.maxRelativeAreaError).toBeGreaterThan(0.018);
  });

  it('refuses on the area limit even when the length error is within its own', () => {
    const base = { latitudeDeg: 60, groundPerGrid: 0.5 };
    expect(webMercatorRefusal({ ...base, maxRelativeError: 0.009, maxRelativeAreaError: 0.011 })).toMatch(/of horizontal cell-area error, more than the 1%/);
    expect(webMercatorRefusal({ ...base, maxRelativeError: 0.009, maxRelativeAreaError: 0.0099 })).toBeNull();
    expect(webMercatorRefusal({ ...base, maxRelativeError: 0.011, maxRelativeAreaError: 0.009 })).toMatch(/of length error, more than the 1%/);
    expect(WEB_MERCATOR_MAX_AREA_ERROR).toBe(WEB_MERCATOR_MAX_SCALE_ERROR);
  });

  it('refuses 59.7 to 60.3 degrees, north and south, on its cell-area error', () => {
    for (const sign of [1, -1]) {
      const b = webMercatorScaleBound(yOf(sign * 59.7), yOf(sign * 60.3));
      expect(b.maxRelativeError).toBeLessThan(0.0101);
      expect(b.maxRelativeAreaError).toBeGreaterThan(0.018);
      expect(webMercatorRefusal(b)).toMatch(/horizontal cell-area error/);
    }
  });

  it('accepts a smaller footprint at the same latitude, in both hemispheres and across the equator', () => {
    for (const [lo, hi] of [[59.9, 60.1], [-60.1, -59.9], [-0.2, 0.2], [39.85, 40.15]]) {
      const b = webMercatorScaleBound(yOf(lo), yOf(hi));
      expect(webMercatorRefusal(b)).toBeNull();
      expect(b.maxRelativeAreaError).toBeLessThanOrEqual(WEB_MERCATOR_MAX_AREA_ERROR);
    }
  });

  it('the length and area bounds hold over many footprints, by dense sampling', () => {
    // A fixed pseudo-random walk, so the cases are the same on every run.
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 200; n++) {
      const c = -80 + 160 * rand();
      const half = 0.01 + 1.5 * rand();
      const y0 = yOf(c - half), y1 = yOf(c + half);
      const b = webMercatorScaleBound(y0, y1);
      let len = 0, area = 0;
      for (let k = 0; k <= 400; k++) {
        const at = webMercatorGroundScale(webMercatorLatitudeOfY(y0 + ((y1 - y0) * k) / 400));
        len = Math.max(len, Math.abs(b.groundPerGrid / at.x - 1), Math.abs(b.groundPerGrid / at.y - 1));
        area = Math.max(area, Math.abs((b.groundPerGrid * b.groundPerGrid) / (at.x * at.y) - 1));
      }
      expect(len).toBeLessThanOrEqual(b.maxRelativeError + 1e-12);
      expect(area).toBeLessThanOrEqual(b.maxRelativeAreaError + 1e-12);
    }
  });

  it('decides at the threshold: just inside is accepted, just outside is refused', () => {
    // Widen a footprint about 50 degrees until its area error first passes 1%.
    let half = 0.01;
    while (webMercatorScaleBound(yOf(50 - half), yOf(50 + half)).maxRelativeAreaError <= WEB_MERCATOR_MAX_AREA_ERROR) half += 0.001;
    expect(webMercatorRefusal(webMercatorScaleBound(yOf(50 - half), yOf(50 + half)))).not.toBeNull();
    expect(webMercatorRefusal(webMercatorScaleBound(yOf(50 - half + 0.001), yOf(50 + half - 0.001)))).toBeNull();
  });

  it('counts the equator when a range crosses it, where the scale is largest', () => {
    const b = webMercatorScaleBound(yOf(-10), yOf(30));
    const equator = webMercatorGroundScale(0);
    expect(b.maxRelativeError).toBeGreaterThanOrEqual(Math.abs(b.groundPerGrid / equator.x - 1));
  });

  it('a continental extent (30° to 40°) is refused with the reason and a way forward', () => {
    const reason = webMercatorRefusal(webMercatorScaleBound(yOf(30), yOf(40)));
    expect(reason).toMatch(/Web Mercator/);
    expect(reason).toMatch(/more than the 1% one ground factor can stand for/);
    expect(reason).toMatch(/reproject it to a local metric CRS such as UTM/);
    expect(WEB_MERCATOR_MAX_SCALE_ERROR).toBe(0.01);
  });

  it('refuses a factor that is not a positive number', () => {
    expect(webMercatorRefusal({ latitudeDeg: Number.NaN, groundPerGrid: Number.NaN, maxRelativeError: 0, maxRelativeAreaError: 0 })).toMatch(/cannot be read/);
  });

  it('states how the run was scaled', () => {
    const note = webMercatorNote(webMercatorScaleBound(yOf(39.55), yOf(39.95)));
    expect(note).toMatch(/ground scale at latitude 39\.7\d°/);
    expect(note).toMatch(/at most 0\.\d\d% error on horizontal lengths and 0\.\d\d% on horizontal cell areas/);
    expect(note).not.toMatch(/slopes and areas/);
    expect(note).toMatch(/projection approximation only, not the accuracy of the data/);
    expect(note).toMatch(/exported georeference stay in Web Mercator/);
    expect(webMercatorNote(undefined)).toBeNull();
  });
});

describe('the terrain run on a Web Mercator scan', () => {
  const base: ResolvedCrs = {
    kind: 'projected', name: 'WGS 84 / Pseudo-Mercator', epsg: 3857, linearUnit: 'metre', linearUnitToMetres: 1,
    verticalUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
  };
  const facts = (crs: ResolvedCrs) => ({ context: () => spatialContextFrom(crs) }) as never;
  /** 1 km by 1 km of points in local coordinates about world northing `originY`. */
  const grid = (): Float32Array => {
    const out: number[] = [];
    for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) out.push(i * 50, j * 50, i + j);
    return Float32Array.from(out);
  };
  const DENVER_Y = yOf(39.75);

  it('takes the ground scale at the scan latitude as its horizontal factor and says so', () => {
    const p = deriveCoreParams(grid(), undefined, facts(base), undefined, false, () => DENVER_Y);
    const expected = webMercatorGroundScale(webMercatorLatitudeOfY(DENVER_Y + 500)).mean;
    expect(p.horizontalUnitToMetres).toBeCloseTo(expected, 6);
    expect(webMercatorBoundFor(p)?.latitudeDeg).toBeCloseTo(webMercatorLatitudeOfY(DENVER_Y + 500), 9);
    expect(webMercatorBoundFor(p)?.groundPerGrid).toBeCloseTo(expected, 9);
    expect(p.horizontalScaleKnown).toBe(true);
    expect(p.isGeographic).toBe(false);
    // The grid-cell floor of 0.25 ground metres, in grid units.
    expect(p.cellSizeM).toBeCloseTo(Math.max(0.25 / expected, 1000 / 256), 9);
  });

  it('refuses, as "did not run", when the scan has no origin to take its latitude from', () => {
    const run = () => deriveCoreParams(grid(), undefined, facts(base), undefined, false, () => null);
    expect(run).toThrow(TerrainRefusalError);
    expect(run).toThrow(/position cannot be read/);
  });

  it('refuses a scan too tall for one factor, with the reason', () => {
    const tall = Float32Array.from([0, 0, 0, 10, yOf(40) - yOf(30), 1]);
    const run = () => deriveCoreParams(tall, undefined, facts(base), undefined, false, () => yOf(30));
    expect(run).toThrow(TerrainRefusalError);
    expect(run).toThrow(/one ground factor can stand for/);
  });

  it('leaves a UTM scan exactly as it was', () => {
    const utm: ResolvedCrs = { ...base, name: 'WGS 84 / UTM zone 13N', epsg: 32613 };
    const p = deriveCoreParams(grid(), undefined, facts(utm), undefined, false, () => 4_400_000);
    expect(p.horizontalUnitToMetres).toBe(1);
    expect(webMercatorBoundFor(p)).toBeUndefined();
  });
});

describe('slope through the real terrain core on a Web Mercator grid', () => {
  const crs: ResolvedCrs = {
    kind: 'projected', name: 'WGS 84 / Pseudo-Mercator', epsg: 3857, linearUnit: 'metre', linearUnitToMetres: 1,
    verticalUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
  };
  const facts = { context: () => spatialContextFrom(crs) } as never;
  const originY = yOf(39.75);

  /** A 500 m by 500 m plane in grid coordinates whose true GROUND gradient is `tan(eastDeg)` east and `tan(northDeg)` north. */
  function plane(eastDeg: number, northDeg: number): Float32Array {
    const s = webMercatorGroundScale(webMercatorLatitudeOfY(originY + 500));
    const ge = Math.tan(rad(eastDeg)) * s.x; // rise per grid metre
    const gn = Math.tan(rad(northDeg)) * s.y;
    const out: number[] = [];
    // 500 m square, a point every 2 m: several points per 5 m cell, so a cell's
    // median is the plane at its centre and no staircase raises the steepest step.
    for (let i = 0; i <= 250; i++) for (let j = 0; j <= 250; j++) out.push(i * 2, j * 2, ge * i * 2 + gn * j * 2);
    return Float32Array.from(out);
  }

  /**
   * The slope of the interior MEASURED cells, in degrees: their median, and the
   * share within `tol` of `expected`. The outer ring is left out because its
   * neighbours are synthesised, and interpolated cells because their slope blends
   * a filled value; the core states both of those itself.
   */
  async function slopeOf(
    eastDeg: number,
    northDeg: number,
    uncorrected = false,
  ): Promise<{ median: number; within: (expected: number, tol: number) => number }> {
    const { computeTerrainCore } = await import('../src/terrain/contour/analyseContours');
    const positions = plane(eastDeg, northDeg);
    const params = deriveCoreParams(positions, undefined, facts, undefined, false, () => originY);
    const sized = { ...params, cellSizeM: 5 };
    const used = uncorrected ? { ...sized, horizontalUnitToMetres: 1 } : sized;
    const core = computeTerrainCore(positions, used as never);
    const { cols, rows, coverage } = core.dtm;
    const tan = core.surface.relief.slope;
    const degs: number[] = [];
    for (let r = 4; r < rows - 4; r++) {
      for (let c = 4; c < cols - 4; c++) {
        if (coverage[r * cols + c] === 2) degs.push((Math.atan(tan[r * cols + c]) * 180) / Math.PI);
      }
    }
    degs.sort((x, y) => x - y);
    return {
      median: degs[Math.floor(degs.length / 2)],
      within: (expected, tol) => degs.filter((d) => Math.abs(d - expected) <= tol).length / degs.length,
    };
  }

  it('reads a 20° east-facing ground slope as 20°: the median and 95% of measured cells', async () => {
    const s = await slopeOf(20, 0);
    expect(Math.abs(s.median - 20)).toBeLessThan(0.1);
    expect(s.within(20, 0.15)).toBeGreaterThan(0.95);
  });

  it('reads a 12° north-facing ground slope as 12°', async () => {
    const s = await slopeOf(0, 12);
    expect(Math.abs(s.median - 12)).toBeLessThan(0.1);
    expect(s.within(12, 0.15)).toBeGreaterThan(0.95);
  });

  it('reads a 15° east, 8° north tilt as the true combined ground slope', async () => {
    const trueDeg = (Math.atan(Math.hypot(Math.tan(rad(15)), Math.tan(rad(8)))) * 180) / Math.PI;
    const s = await slopeOf(15, 8);
    expect(Math.abs(s.median - trueDeg)).toBeLessThan(0.1);
    expect(s.within(trueDeg, 0.15)).toBeGreaterThan(0.95);
  });

  it('would read the same 20° plane about 4.4° too flat at Denver without it (the error the old refusal protected against)', async () => {
    const withScale = await slopeOf(20, 0);
    const without = await slopeOf(20, 0, true);
    expect(withScale.median - without.median).toBeGreaterThan(4);
    expect(without.median).toBeLessThan(16);
  });
});
