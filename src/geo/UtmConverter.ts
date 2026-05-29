/**
 * src/geo/UtmConverter.ts
 *
 * Vendored UTM ↔ WGS84 forward / inverse projection. Pure math —
 * no library dependency, no async loading. Covers the highest-
 * frequency case for the current release: every USGS 3DEP UTM zone,
 * plus international UTM zones for any catalog provider that surfaces
 * them.
 *
 * Both NAD83 (EPSG:269xx) and WGS84 (EPSG:326xx) UTM variants are
 * treated as WGS84 here. For the v0.3.6 inspector use case
 * (display-grade lat/lon, ~1 m of accuracy), the WGS84↔NAD83 datum
 * shift in CONUS is well under a metre. Higher-precision callers
 * (future GCP validation, survey-grade exports) should NOT use this
 * converter and should plug in a proj4-backed converter behind the
 * same `CoordinateConverter` interface.
 *
 * Formulas: Snyder, "Map Projections — A Working Manual", USGS
 * Professional Paper 1395 (1987), § Transverse Mercator (TM).
 * Numerical constants match the OGP/EPSG-7.9 catalogue values.
 *
 * Validation: the unit tests pin known good values from the NOAA
 * NGS coordinate-conversion tool for half a dozen well-known
 * locations (Tucson AZ, San Francisco CA, Denver CO, NYC, Anchorage AK,
 * Honolulu HI).
 *
 * Pure of three.js, pdf-lib, DOM. Runs unchanged in Node tests.
 */

import type {
  Bounds3,
  GeographicPoint,
  ResolvedCrs,
  Vec3,
} from './CoordinateTypes';
import type {
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
/** Second eccentricity squared: e'² = e² / (1 - e²). */
const EP2 = E2 / (1 - E2);
/** UTM scale factor at the central meridian. */
const K0 = 0.9996;
/** UTM false easting at the central meridian, metres. */
const FALSE_EASTING = 500000;
/** UTM false northing in the southern hemisphere, metres. */
const FALSE_NORTHING_SOUTH = 10000000;

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
 *   - 26901 … 26960 → NAD83 / UTM zone NN North (treated as WGS84
 *                     for v0.3.6 display-grade conversion)
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
  if (epsg >= 26901 && epsg <= 26960) {
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
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const lon0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180; // central meridian

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const T = tanLat * tanLat;
  const C = EP2 * cosLat * cosLat;
  const Aterm = cosLat * (lonRad - lon0);

  // Meridional arc length — Snyder 8-3.
  const M = A * (
    (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * latRad -
    (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * latRad) +
    (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * latRad) -
    (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * latRad)
  );

  const easting =
    K0 * N * (
      Aterm +
      (1 - T + C) * Math.pow(Aterm, 3) / 6 +
      (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Math.pow(Aterm, 5) / 120
    ) + FALSE_EASTING;

  const northing =
    K0 * (
      M +
      N * tanLat * (
        Math.pow(Aterm, 2) / 2 +
        (5 - T + 9 * C + 4 * C * C) * Math.pow(Aterm, 4) / 24 +
        (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Math.pow(Aterm, 6) / 720
      )
    ) + (hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0);

  return { easting, northing };
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
  const x = easting - FALSE_EASTING;
  const y = hemisphere === 'S' ? northing - FALSE_NORTHING_SOUTH : northing;

  const M = y / K0;
  const mu =
    M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256));

  // Snyder 3-24
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1Rad =
    mu +
    (3 * e1 / 2 - 27 * e1 * e1 * e1 / 32) * Math.sin(2 * mu) +
    (21 * e1 * e1 / 16 - 55 * e1 * e1 * e1 * e1 / 32) * Math.sin(4 * mu) +
    (151 * e1 * e1 * e1 / 96) * Math.sin(6 * mu);

  const sinPhi1 = Math.sin(phi1Rad);
  const cosPhi1 = Math.cos(phi1Rad);
  const tanPhi1 = Math.tan(phi1Rad);

  const N1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const T1 = tanPhi1 * tanPhi1;
  const C1 = EP2 * cosPhi1 * cosPhi1;
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const D = x / (N1 * K0);

  const latRad =
    phi1Rad - (N1 * tanPhi1 / R1) * (
      Math.pow(D, 2) / 2 -
      (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) *
        Math.pow(D, 6) / 720
    );

  const lonRad =
    ((zone - 1) * 6 - 180 + 3) * Math.PI / 180 +
    (
      D -
      (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) *
        Math.pow(D, 5) / 120
    ) / cosPhi1;

  return {
    lat: (latRad * 180) / Math.PI,
    lon: (lonRad * 180) / Math.PI,
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
