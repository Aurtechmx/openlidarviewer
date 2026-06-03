/**
 * src/geo/CoordinateConverter.ts
 *
 * The coordinate-conversion seam.
 *
 * The viewer's runtime never calls a projection library directly — it
 * goes through a `CoordinateConverter`. That gives us three things:
 *
 *   1. **Lazy load discipline.** v0.3.6 ships with a vendored UTM +
 *      Web Mercator converter covering the highest-frequency cases
 *      (every USGS 3DEP UTM zone, plus Web Mercator). Future releases
 *      can plug in a proj4-backed converter behind the same interface
 *      and load it only when called — never on the initial shell.
 *
 *   2. **Explicit `canConvert`.** Callers must check whether a pair is
 *      supported before they call convert; the UI gates the "show
 *      lat/lon" affordance on this. No silent fallback.
 *
 *   3. **Transparent failure modes.** When a conversion isn't
 *      supported, the converter returns a tagged failure rather than
 *      a guess. The Inspector surfaces the failure mode directly so
 *      the user sees which CRS pair is unsupported.
 *
 * Pure of three.js / pdf-lib / DOM. The vendored math lives in
 * sibling files (`UtmConverter.ts`, `WebMercatorConverter.ts`).
 */

import type {
  Bounds3,
  GeographicPoint,
  ResolvedCrs,
  Vec3,
} from './CoordinateTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Conversion outcomes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A conversion that succeeded. `value` is in the target CRS — either
 * a `Vec3`, a `GeographicPoint`, or a `Bounds3` depending on which
 * converter method was called. The wrapper shape is uniform so the
 * Inspector's "did this succeed" check is the same regardless of
 * shape.
 */
export interface ConvertedPoint<T> {
  readonly ok: true;
  readonly value: T;
  /**
   * Which converter handled this call. Recorded in the Inspector + the
   * report's Methods appendix so the user can audit the conversion
   * chain.
   */
  readonly method: ConverterMethod;
}

/** A conversion that failed safely. The Inspector renders `reason` verbatim. */
export interface ConversionFailure {
  readonly ok: false;
  readonly code:
    | 'unsupported-pair' // no registered converter handles this CRS pair
    | 'unknown-crs'      // one of the CRSs is `unknown` / `local`
    | 'out-of-bounds'    // input was outside the converter's valid range
    | 'invalid-input';   // input was non-finite or malformed
  readonly reason: string;
}

export type ConversionResult<T> = ConvertedPoint<T> | ConversionFailure;

/**
 * Tag for which underlying converter produced the result. The set grows
 * as new converters are registered; `'vendored-utm'` and
 * `'vendored-web-mercator'` cover v0.3.6.
 */
export type ConverterMethod = 'vendored-utm' | 'vendored-web-mercator' | 'proj4';

// ─────────────────────────────────────────────────────────────────────────────
// The interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every coordinate converter implements this contract. v0.3.6 ships
 * one implementation (`createDefaultConverter()`); future releases
 * can register proj4-backed converters behind the same interface.
 */
export interface CoordinateConverter {
  /**
   * Whether this converter can handle the supplied CRS pair. Callers
   * gate UI affordances on this — `false` means the inspector hides
   * the "show lat/lon" row.
   */
  canConvert(from: ResolvedCrs, to: ResolvedCrs): boolean;

  /**
   * Convert a single point from the `from` CRS to the `to` CRS. Returns
   * a tagged failure when the pair is unsupported or the input is
   * out of range — never throws.
   *
   * The point's `z` is passed through unchanged for projected ↔
   * geographic conversions (no datum transformation applied to
   * elevation in v0.3.6).
   */
  convertPoint(point: Vec3, from: ResolvedCrs, to: ResolvedCrs): ConversionResult<Vec3>;

  /**
   * Convenience: convert a projected point directly to a geographic
   * point. Equivalent to `convertPoint(p, from, wgs84)` followed by a
   * shape coercion, with the elevation surfaced separately.
   */
  toGeographic(
    point: Vec3,
    from: ResolvedCrs,
  ): ConversionResult<GeographicPoint>;

  /**
   * Convert a 3-D AABB by converting both corners and re-deriving
   * min/max. NOT exact for rotated CRS pairs — for high-precision
   * uses the caller should sample the edges. Sufficient for the
   * Inspector's "approximate lat/lon bounds" disclosure.
   */
  convertBounds(bounds: Bounds3, from: ResolvedCrs, to: ResolvedCrs): ConversionResult<Bounds3>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The no-op converter — always-available fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A converter that rejects every cross-CRS request. Used as a safe
 * fallback in environments where the real converter chunk failed to
 * load, and in unit tests that need a converter handle without any
 * runtime cost.
 */
export const noopConverter: CoordinateConverter = {
  canConvert(): boolean {
    return false;
  },
  convertPoint(): ConversionResult<Vec3> {
    return {
      ok: false,
      code: 'unsupported-pair',
      reason: 'No coordinate converter is registered for this CRS pair.',
    };
  },
  toGeographic(): ConversionResult<GeographicPoint> {
    return {
      ok: false,
      code: 'unsupported-pair',
      reason: 'No coordinate converter is registered for this CRS pair.',
    };
  },
  convertBounds(): ConversionResult<Bounds3> {
    return {
      ok: false,
      code: 'unsupported-pair',
      reason: 'No coordinate converter is registered for this CRS pair.',
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers used by every implementation
// ─────────────────────────────────────────────────────────────────────────────

/** True when every component of a Vec3 is finite (no NaN, no Infinity). */
export function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

/**
 * Build a generic invalid-input failure. Centralised so every
 * converter surfaces the same phrasing.
 */
export function invalidInputFailure(detail: string): ConversionFailure {
  return {
    ok: false,
    code: 'invalid-input',
    reason: `Coordinate conversion: ${detail}`,
  };
}

/** Build a generic unsupported-pair failure. */
export function unsupportedPairFailure(
  from: ResolvedCrs,
  to: ResolvedCrs,
): ConversionFailure {
  return {
    ok: false,
    code: 'unsupported-pair',
    reason: `No converter registered for ${describeCrs(from)} → ${describeCrs(to)}.`,
  };
}

/** Build a generic unknown-CRS failure. */
export function unknownCrsFailure(which: 'source' | 'target'): ConversionFailure {
  return {
    ok: false,
    code: 'unknown-crs',
    reason: `Cannot convert: the ${which} CRS is unknown or local.`,
  };
}

function describeCrs(crs: ResolvedCrs): string {
  if (typeof crs.epsg === 'number') return `EPSG:${crs.epsg}`;
  return crs.name;
}
