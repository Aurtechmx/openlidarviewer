/**
 * src/geo/UtmConverter.ts
 *
 * Vendored UTM ↔ WGS84 forward / inverse projection. Pure math —
 * no library dependency, no async loading. Covers the highest-
 * frequency case for the current release: every USGS 3DEP UTM zone,
 * plus international UTM zones for any catalog provider that surfaces
 * them.
 *
 * Both NAD83 (EPSG:26901-26923) and WGS84 (EPSG:326xx) UTM variants are
 * decoded with WGS84 constants and no datum shift. That is NOT exact for
 * NAD83: NAD83(2011) and WGS 84 (ITRF2014, epoch 2026.75) differ by 0.9 to
 * 1.6 m across the conterminous United States (0.89 m at Miami, 1.40 m at
 * -100, 40, 1.61 m at Seattle), so
 * NAD83 output is display-grade, good to about 1 to 2 m. Callers that
 * publish it (the longitude/latitude exports) must say so; higher-precision
 * callers (GCP validation, survey-grade exports) should NOT use this
 * converter and should plug in a datum-aware converter behind the same
 * `CoordinateConverter` interface.
 *
 * Formulas: the Krüger series to sixth order in the third flattening,
 * C. F. F. Karney, "Transverse Mercator with an accuracy of a few
 * nanometers", J. Geodesy 85 (2011) 475-485, the method PROJ's utm and
 * etmerc use. The truncated Snyder series it replaces drifted with distance
 * from the central meridian (3.0 m at 27 E, 79.6 N in zone 33).
 *
 * Validation: tests/utmKrugerAccuracy.test.ts compares both directions with
 * proj4's utm over the whole accepted easting range (100 000 to 900 000 m)
 * and the UTM latitudes, to under 1 mm; the unit tests also pin values from
 * the NOAA NGS coordinate-conversion tool for half a dozen locations.
 *
 * Pure of three.js, pdf-lib, DOM. Runs unchanged in Node tests.
 */

import { clamp } from '../numeric';
import type {
  Bounds3,
  GeographicPoint,
  ResolvedCrs,
  Vec3,
} from './CoordinateTypes';
import type {
  ConversionFailure,
  ConversionResult,
  CoordinateConverter,
} from './CoordinateConverter';
import {
  invalidInputFailure,
  isFiniteVec3,
  unknownCrsFailure,
  unsupportedPairFailure,
} from './CoordinateConverter';

// ─────────────────────────────────────────────────────────────────────────────
// WGS84 constants
// ─────────────────────────────────────────────────────────────────────────────

/** WGS84 semi-major axis, metres. */
const A = 6378137.0;
/** WGS84 inverse flattening. */
const INV_F = 298.257223563;
/** WGS84 first eccentricity squared: e² = 1 - (1 - 1/f)². */
const E2 = 1 - Math.pow(1 - 1 / INV_F, 2);
/** UTM scale factor at the central meridian. */
const K0 = 0.9996;
/** UTM false easting at the central meridian, metres. */
const FALSE_EASTING = 500000;
/** UTM false northing in the southern hemisphere, metres. */
const FALSE_NORTHING_SOUTH = 10000000;

/**
 * The UTM grid's valid coordinate range, metres. A zone spans 6° of longitude
 * (about 667 km at the equator) about a false easting of 500 000, so real
 * eastings sit inside 100 000–900 000; northings run pole to pole once the
 * southern false northing is applied.
 */
const MIN_EASTING = 100000;
const MAX_EASTING = 900000;
// Northings get a ~100 km overlap either side of the nominal span. A survey
// straddling the equator keeps ONE zone/hemisphere code for the whole tile, so
// a southern (327xx) northing legitimately passes 10 000 000 and a northern
// (326xx) one goes negative. Hard bounds at 0 and 10 000 000 refused real data
// from Ecuador, Colombia, Kenya and Indonesia.
const NORTHING_OVERLAP = 100000;
const MIN_NORTHING = -NORTHING_OVERLAP;
const MAX_NORTHING = 10000000 + NORTHING_OVERLAP;

/**
 * Refuse a grid coordinate the converter cannot honestly interpret.
 *
 * The series maths returns a confident lat/lon for ANY pair of numbers: easting
 * 5 000 000 in zone 12N used to resolve to lat 27.677 / lon -66.801 — a point in
 * the Atlantic — with `ok: true`, and the KML export wrote a placemark there.
 * `out-of-bounds` has been in the {@link ConversionFailure} contract since the
 * interface was written and nothing had ever emitted it.
 *
 * This catches GROSS implausibility: garbage, a unit confusion (feet read as
 * metres), or geographic degrees handed in as projected metres — the shape a
 * lat/lon cloud takes when its CRS is overridden to a UTM code. It cannot catch
 * an adjacent-zone mislabel, because an easting valid in one zone is valid in
 * every zone: a true zone-12 point at easting 500 000 labelled zone 13 stays in
 * range and still resolves about 500 km east. Detecting that needs a second
 * signal — a catalog EPSG, or a declared geographic bounding box — rather than
 * a range test, and none is available on a plain LAS.
 */
function utmRangeFailure(easting: number, northing: number): ConversionFailure | null {
  if (easting < MIN_EASTING || easting > MAX_EASTING) {
    return {
      ok: false,
      code: 'out-of-bounds',
      reason:
        `Easting ${easting} is outside the UTM grid range ` +
        `(${MIN_EASTING}–${MAX_EASTING} m), so this scan's coordinates don't ` +
        `match the declared UTM zone.`,
    };
  }
  if (northing < MIN_NORTHING || northing > MAX_NORTHING) {
    return {
      ok: false,
      code: 'out-of-bounds',
      reason:
        `Northing ${northing} is outside the UTM grid range ` +
        `(${MIN_NORTHING}–${MAX_NORTHING} m), so this scan's coordinates don't ` +
        `match the declared UTM zone.`,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTM EPSG code mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode an EPSG code into (zone, hemisphere) for the UTM zones we
 * support. Returns `null` for non-UTM codes so callers can probe.
 *
 * Recognised ranges:
 *   - 32601 … 32660 → WGS84 / UTM zone NN North
 *   - 32701 … 32760 → WGS84 / UTM zone NN South
 *   - 26901 … 26923 → NAD83 / UTM zone NN North (treated as WGS84,
 *                     about 1 to 2 m off). 26929 and up are NAD83 State
 *                     Plane zones (26929 is Alabama East), not UTM.
 */
function decodeUtmEpsg(
  epsg: number,
): { zone: number; hemisphere: 'N' | 'S' } | null {
  if (epsg >= 32601 && epsg <= 32660) {
    return { zone: epsg - 32600, hemisphere: 'N' };
  }
  if (epsg >= 32701 && epsg <= 32760) {
    return { zone: epsg - 32700, hemisphere: 'S' };
  }
  if (epsg >= 26901 && epsg <= 26923) {
    return { zone: epsg - 26900, hemisphere: 'N' };
  }
  return null;
}

/** True when this resolved CRS is a UTM zone we can handle. */
function isSupportedUtm(crs: ResolvedCrs): boolean {
  return typeof crs.epsg === 'number' && decodeUtmEpsg(crs.epsg) !== null;
}

/** True when this resolved CRS is WGS84 lat/lon (EPSG:4326 or 4979). */
function isWgs84LatLon(crs: ResolvedCrs): boolean {
  return crs.epsg === 4326 || crs.epsg === 4979;
}

// ─────────────────────────────────────────────────────────────────────────────
// Krüger series (Karney 2011, sixth order in the third flattening n)
// ─────────────────────────────────────────────────────────────────────────────

/** WGS84 first eccentricity. */
const E = Math.sqrt(E2);
/** Third flattening n = f / (2 - f). */
const N3 = (1 / INV_F) / (2 - 1 / INV_F);
/** Rectifying radius A = a / (1 + n) * (1 + n²/4 + n⁴/64 + n⁶/256). */
const RECT_A = (A / (1 + N3)) * (1 + N3 ** 2 / 4 + N3 ** 4 / 64 + N3 ** 6 / 256);

/** Forward series coefficients α1..α6 (Karney 2011, eq. 35). */
const ALPHA: readonly number[] = (() => {
  const n = N3;
  return [
    n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180 - (127 * n ** 5) / 288 + (7891 * n ** 6) / 37800,
    (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440 + (281 * n ** 5) / 630 - (1983433 * n ** 6) / 1935360,
    (61 * n ** 3) / 240 - (103 * n ** 4) / 140 + (15061 * n ** 5) / 26880 + (167603 * n ** 6) / 181440,
    (49561 * n ** 4) / 161280 - (179 * n ** 5) / 168 + (6601661 * n ** 6) / 7257600,
    (34729 * n ** 5) / 80640 - (3418889 * n ** 6) / 1995840,
    (212378941 * n ** 6) / 319334400,
  ];
})();

/** Inverse series coefficients β1..β6 (Karney 2011, eq. 36). */
const BETA: readonly number[] = (() => {
  const n = N3;
  return [
    n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360 - (81 * n ** 5) / 512 + (96199 * n ** 6) / 604800,
    n ** 2 / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440 + (46 * n ** 5) / 105 - (1118711 * n ** 6) / 3870720,
    (17 * n ** 3) / 480 - (37 * n ** 4) / 840 - (209 * n ** 5) / 4480 + (5569 * n ** 6) / 90720,
    (4397 * n ** 4) / 161280 - (11 * n ** 5) / 504 - (830251 * n ** 6) / 7257600,
    (4583 * n ** 5) / 161280 - (108847 * n ** 6) / 3991680,
    (20648693 * n ** 6) / 638668800,
  ];
})();

/** Central meridian of a UTM zone, radians. */
function centralMeridianRad(zone: number): number {
  return (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
}

/** tan of the conformal latitude for tan φ = tau (Karney 2011, eq. 7). */
function conformalTan(tau: number): number {
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.hypot(1, tau)));
  return tau * Math.hypot(1, sigma) - sigma * Math.hypot(1, tau);
}

/** Invert {@link conformalTan} by Newton's method (Karney 2011, eqs. 19-21). */
function geodeticTan(tauPrime: number): number {
  let tau = tauPrime;
  for (let i = 0; i < 6; i++) {
    const tp = conformalTan(tau);
    const dTau =
      ((tauPrime - tp) / Math.hypot(1, tp)) *
      ((1 + (1 - E2) * tau * tau) / ((1 - E2) * Math.hypot(1, tau)));
    tau += dTau;
    if (Math.abs(dTau) < 1e-14 * Math.max(1, Math.abs(tau))) break;
  }
  return tau;
}

// ─────────────────────────────────────────────────────────────────────────────
// Forward — geographic (lat/lon) → UTM (easting/northing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert WGS84 lat/lon (degrees) to UTM easting/northing (metres).
 * The zone is supplied explicitly so callers can target a specific
 * grid (rather than the zone the latitude/longitude would normally
 * fall into) — this is what 3DEP queries need when the catalog
 * returns a tile from an adjacent zone.
 */
function geographicToUtm(
  lat: number,
  lon: number,
  zone: number,
  hemisphere: 'N' | 'S',
): { easting: number; northing: number } {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180 - centralMeridianRad(zone);
  const tauPrime = conformalTan(Math.tan(phi));
  const xiPrime = Math.atan2(tauPrime, Math.cos(lambda));
  const etaPrime = Math.asinh(Math.sin(lambda) / Math.hypot(tauPrime, Math.cos(lambda)));
  let xi = xiPrime;
  let eta = etaPrime;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1];
    xi += a * Math.sin(2 * j * xiPrime) * Math.cosh(2 * j * etaPrime);
    eta += a * Math.cos(2 * j * xiPrime) * Math.sinh(2 * j * etaPrime);
  }
  return {
    easting: K0 * RECT_A * eta + FALSE_EASTING,
    northing: K0 * RECT_A * xi + (hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inverse — UTM (easting/northing) → geographic (lat/lon)
// ─────────────────────────────────────────────────────────────────────────────

/** Convert UTM easting/northing (metres) to WGS84 lat/lon (degrees). */
function utmToGeographic(
  easting: number,
  northing: number,
  zone: number,
  hemisphere: 'N' | 'S',
): { lat: number; lon: number } {
  const xi = (hemisphere === 'S' ? northing - FALSE_NORTHING_SOUTH : northing) / (K0 * RECT_A);
  const eta = (easting - FALSE_EASTING) / (K0 * RECT_A);
  let xiPrime = xi;
  let etaPrime = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1];
    xiPrime -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaPrime -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const sinhEta = Math.sinh(etaPrime);
  const cosXi = Math.cos(xiPrime);
  const tauPrime = Math.sin(xiPrime) / Math.hypot(sinhEta, cosXi);
  const lambda = Math.atan2(sinhEta, cosXi);
  const phi = Math.atan(geodeticTan(tauPrime));
  return {
    lat: (phi * 180) / Math.PI,
    lon: ((centralMeridianRad(zone) + lambda) * 180) / Math.PI,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers — UTM zone derivation
// ─────────────────────────────────────────────────────────────────────────────

/** A UTM grid coordinate with the zone + hemisphere that derived it. */
export interface UtmGridPoint {
  readonly zone: number;
  readonly hemisphere: 'N' | 'S';
  readonly easting: number;
  readonly northing: number;
  readonly elevation?: number;
}

/**
 * Compute the canonical UTM zone for a given WGS-84 latitude / longitude.
 * Falls within 1-60 inclusive; clamps the longitude to [-180, 180).
 * Hemisphere is 'N' for non-negative latitudes, 'S' otherwise.
 */
export function utmZoneFor(lat: number, lon: number): {
  zone: number;
  hemisphere: 'N' | 'S';
} {
  // Normalise longitude into [-180, 180) so the zone math stays
  // well-defined at the antimeridian.
  let normLon = ((lon + 180) % 360 + 360) % 360 - 180;
  if (normLon === 180) normLon = -180;
  let zone = clamp(Math.floor((normLon + 180) / 6) + 1, 1, 60);

  // Two regions do not follow the formula, and both are in the UTM/EPSG
  // definition rather than local convention — so computing them by longitude
  // alone puts real survey areas in a zone PROJ and every other tool disagree
  // with, by a whole 6° of grid.
  //
  // South-west Norway: zone 32 is widened to 3°E–12°E between 56°N and 64°N.
  if (lat >= 56 && lat < 64 && normLon >= 3 && normLon < 12) zone = 32;
  // Svalbard: zones 31, 33, 35 and 37 are widened between 72°N and 84°N,
  // and zones 32, 34 and 36 do not exist there.
  else if (lat >= 72 && lat < 84) {
    if (normLon >= 0 && normLon < 9) zone = 31;
    else if (normLon >= 9 && normLon < 21) zone = 33;
    else if (normLon >= 21 && normLon < 33) zone = 35;
    else if (normLon >= 33 && normLon < 42) zone = 37;
  }

  const hemisphere: 'N' | 'S' = lat >= 0 ? 'N' : 'S';
  return { zone, hemisphere };
}

/** Southern and northern limits of the UTM system, in degrees. */
const UTM_MIN_LAT = -80;
const UTM_MAX_LAT = 84;

/**
 * Why a latitude is outside UTM's domain, or null when it is inside.
 *
 * UTM covers 80°S to 84°N; the poles are UPS. The zone maths happily returns
 * finite numbers past those limits, so a point at 85°N came back with an
 * easting and northing that look ordinary and match no other tool. A grid
 * coordinate outside the system's own domain is not an approximation, it is
 * a different answer to a different question.
 */
export function utmLatitudeFailure(lat: number): string | null {
  if (!Number.isFinite(lat)) return 'Latitude is not a finite number.';
  if (lat < UTM_MIN_LAT || lat > UTM_MAX_LAT) {
    return `Latitude ${lat.toFixed(4)}° is outside the UTM system, which covers `
      + `${UTM_MIN_LAT}° to ${UTM_MAX_LAT}°. Polar coordinates use UPS, not UTM.`;
  }
  return null;
}

/**
 * Convert a WGS-84 lat / lon (with optional elevation) to its canonical
 * UTM grid coordinate. Returns the easting, northing, zone, hemisphere
 * — exactly what the v0.3.8-carryover point inspector needs to surface
 * a UTM row regardless of the source CRS.
 */
export function latLonToUtm(
  lat: number,
  lon: number,
  elevation?: number,
): UtmGridPoint {
  const { zone, hemisphere } = utmZoneFor(lat, lon);
  const { easting, northing } = geographicToUtm(lat, lon, zone, hemisphere);
  return {
    zone,
    hemisphere,
    easting,
    northing,
    ...(elevation !== undefined ? { elevation } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CoordinateConverter implementation
// ─────────────────────────────────────────────────────────────────────────────

export const utmConverter: CoordinateConverter = {
  canConvert(from, to): boolean {
    // Forward: UTM → WGS84 lat/lon
    if (isSupportedUtm(from) && isWgs84LatLon(to)) return true;
    // Inverse: WGS84 lat/lon → UTM
    if (isWgs84LatLon(from) && isSupportedUtm(to)) return true;
    return false;
  },

  convertPoint(point, from, to): ConversionResult<Vec3> {
    if (!isFiniteVec3(point)) return invalidInputFailure('non-finite input.');
    if (from.kind === 'unknown' || from.kind === 'local') {
      return unknownCrsFailure('source');
    }
    if (to.kind === 'unknown' || to.kind === 'local') {
      return unknownCrsFailure('target');
    }

    // UTM → WGS84 lat/lon
    if (isSupportedUtm(from) && isWgs84LatLon(to)) {
      const fromEpsg = decodeUtmEpsg(from.epsg as number);
      if (!fromEpsg) return unsupportedPairFailure(from, to);
      // Same gate as `toGeographic` — this is the path the Inspector reads, so
      // leaving it open would still surface a confident lat/lon for a
      // coordinate the converter cannot interpret.
      const range = utmRangeFailure(point.x, point.y);
      if (range) return range;
      const { lat, lon } = utmToGeographic(
        point.x,
        point.y,
        fromEpsg.zone,
        fromEpsg.hemisphere,
      );
      return {
        ok: true,
        value: { x: lon, y: lat, z: point.z },
        method: 'vendored-utm',
      };
    }

    // WGS84 lat/lon → UTM
    if (isWgs84LatLon(from) && isSupportedUtm(to)) {
      const toEpsg = decodeUtmEpsg(to.epsg as number);
      if (!toEpsg) return unsupportedPairFailure(from, to);
      // Convention: when from is `WGS84 lat/lon`, the caller stores
      // longitude in `x` and latitude in `y` (matching GeoJSON order).
      const { easting, northing } = geographicToUtm(
        point.y, // lat
        point.x, // lon
        toEpsg.zone,
        toEpsg.hemisphere,
      );
      return {
        ok: true,
        value: { x: easting, y: northing, z: point.z },
        method: 'vendored-utm',
      };
    }

    return unsupportedPairFailure(from, to);
  },

  toGeographic(point, from): ConversionResult<GeographicPoint> {
    if (!isFiniteVec3(point)) return invalidInputFailure('non-finite input.');
    if (!isSupportedUtm(from)) {
      return {
        ok: false,
        code: 'unsupported-pair',
        reason: 'UTM converter only handles UTM → WGS84 source pairs.',
      };
    }
    const epsgInfo = decodeUtmEpsg(from.epsg as number);
    if (!epsgInfo) {
      return {
        ok: false,
        code: 'unsupported-pair',
        reason: `EPSG:${from.epsg} is not a supported UTM zone.`,
      };
    }
    const range = utmRangeFailure(point.x, point.y);
    if (range) return range;
    const { lat, lon } = utmToGeographic(
      point.x,
      point.y,
      epsgInfo.zone,
      epsgInfo.hemisphere,
    );
    return {
      ok: true,
      value: { lat, lon, elevation: point.z },
      method: 'vendored-utm',
    };
  },

  convertBounds(bounds, from, to): ConversionResult<Bounds3> {
    const minResult = this.convertPoint(bounds.min, from, to);
    if (!minResult.ok) return minResult;
    const maxResult = this.convertPoint(bounds.max, from, to);
    if (!maxResult.ok) return maxResult;
    return {
      ok: true,
      method: minResult.method,
      value: {
        min: {
          x: Math.min(minResult.value.x, maxResult.value.x),
          y: Math.min(minResult.value.y, maxResult.value.y),
          z: Math.min(minResult.value.z, maxResult.value.z),
        },
        max: {
          x: Math.max(minResult.value.x, maxResult.value.x),
          y: Math.max(minResult.value.y, maxResult.value.y),
          z: Math.max(minResult.value.z, maxResult.value.z),
        },
      },
    };
  },
};
