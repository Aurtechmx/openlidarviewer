/**
 * src/geo/CoordinateTypes.ts
 *
 * Shared type contracts for the CRS + coordinate-conversion seam. Sits
 * one layer above the raw `CrsInfo` extracted by `src/io/crs.ts` and
 * carries the additional fields the rest of the platform needs:
 * confidence, source-of-truth, the optional user override, and a
 * stable shape the converter / inspector / report engine all key
 * against.
 *
 * Pure types — no DOM, no proj4. Runs unchanged in Node tests.
 */

import type { CrsInfo, CrsLinearUnit } from '../io/crs';

// ─────────────────────────────────────────────────────────────────────────────
// CRS classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The coarse shape of a coordinate system. The viewer treats each
 * differently for measurement, display, and conversion purposes.
 *
 * `local` — the dataset has no CRS, coordinates are in arbitrary units
 *           (phone scans, raw scanner output). Cannot be reprojected.
 * `projected` — metric coordinates on a plane (UTM, state plane).
 *               Distances are trustworthy; conversion to lat/lon is
 *               well-defined.
 * `geographic` — lat/lon in degrees. Distances need projection to be
 *                metric-accurate; conversion to a projected CRS is
 *                well-defined.
 * `unknown` — the CRS detector found no metadata.
 */
export type CrsKind = 'local' | 'projected' | 'geographic' | 'unknown';

/**
 * Where the CRS metadata came from. Surfaced in the Inspector so the
 * user can judge how much to trust the detection, and recorded in the
 * report's Methods appendix.
 *
 * `las-vlr` — LAS/LAZ georeference VLR (WKT or GeoTIFF).
 * `copc-meta` — COPC info VLR (LAS-VLR-equivalent on COPC files).
 * `ept-srs` — EPT manifest `srs.wkt` field.
 * `catalog-tile` — Public-catalog tile metadata (USGS 3DEP, etc.).
 * `user-override` — User explicitly chose a CRS in the override panel.
 * `default-assumption` — None of the above; the viewer is operating
 *                         on the documented default for the source
 *                         format (rare, last-resort path).
 */
export type CrsSource =
  | 'las-vlr'
  | 'copc-meta'
  | 'ept-srs'
  | 'catalog-tile'
  | 'user-override'
  | 'default-assumption';

/**
 * Confidence in the detected CRS. Drives the safety-warning text in
 * the Inspector and the visibility of the override prompt.
 *
 * `high` — VLR or manifest carried a complete WKT + EPSG code that
 *          parsed cleanly.
 * `medium` — Only one of (EPSG code, recognisable WKT name) was
 *            present; the other had to be inferred.
 * `low` — Metadata was incomplete or ambiguous (EPSG missing, WKT
 *         truncated, conflicting axes). The Inspector should prompt
 *         for confirmation before any conversion is performed.
 * `none` — No CRS metadata at all. `kind` will be `'unknown'`.
 */
export type CrsConfidence = 'high' | 'medium' | 'low' | 'none';

// ─────────────────────────────────────────────────────────────────────────────
// Resolved CRS — the shape the rest of the platform consumes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A CRS, resolved against all available signals. This is the single
 * shape the inspector, point-inspector, report engine, session
 * encoder, and the converter all key against.
 *
 * Build one with `resolveCrs(detected, override?, formatHint?)` from
 * `CrsDetection.ts`. Consumers should NEVER assemble a `ResolvedCrs`
 * by hand — the rules for combining detection + override + format-
 * default belong in one place.
 */
export interface ResolvedCrs {
  readonly kind: CrsKind;
  /**
   * Human-readable label. For projected/geographic CRSs this is the
   * EPSG-derived name where available, otherwise the WKT name, with
   * `EPSG:<code>` as a last-resort fallback. For local datasets this
   * is `'Local coordinates (no CRS)'`.
   */
  readonly name: string;
  /**
   * EPSG code when known. Absent for local-coordinate datasets and
   * for datasets whose WKT didn't yield a recognisable EPSG.
   */
  readonly epsg?: number;
  readonly linearUnit: CrsLinearUnit;
  readonly linearUnitToMetres: number;
  readonly source: CrsSource;
  readonly confidence: CrsConfidence;
  /**
   * Whether the user has explicitly confirmed or overridden this CRS.
   * Drives the persistence layer (the override flag is round-tripped
   * via the session encoder) and the "override active" Inspector
   * warning.
   */
  readonly userConfirmed: boolean;
  /**
   * Original WKT if the source carried one. Kept so the Inspector
   * can offer a "show raw WKT" disclosure for users who need to
   * audit the detection.
   */
  readonly wkt?: string;
  /** Vertical (height) datum EPSG, when the source declares one. */
  readonly verticalEpsg?: number;
  /** Human label for the vertical datum (name or `EPSG:<code>`); undefined = unknown. */
  readonly verticalDatum?: string;
  /**
   * Horizontal geodetic datum name (e.g. "NAD83(2011)", "WGS 84", "ETRS89"),
   * resolved consistently across every path: a WKT-declared datum always wins,
   * the curated registry fills the gap by EPSG, and `undefined` is an honest
   * "unknown". The single source of truth so the inspector, reports, and
   * epoch-comparison never infer the datum three different ways.
   */
  readonly horizontalDatum?: string;
  /**
   * Z-axis unit conversion to metres, when the source declares a vertical unit
   * distinct from the horizontal one. Absent ⇒ use {@link linearUnitToMetres}
   * (the GeoTIFF default: vertical units follow the model's linear units).
   */
  readonly verticalUnitToMetres?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Point shapes — every coordinate the platform talks about
// ─────────────────────────────────────────────────────────────────────────────

/** A 3-D point. The semantics depend on which space it's in. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A geographic point — degrees + elevation in metres. */
export interface GeographicPoint {
  readonly lat: number;
  readonly lon: number;
  /** Elevation in metres. Optional because not every conversion produces one. */
  readonly elevation?: number;
}

/** A 3-D AABB. Same x/y/z semantics as the points it bounds. */
export interface Bounds3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridges — how to bring an existing CrsInfo into the ResolvedCrs world
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Translate the existing `CrsInfo` (LAS/LAZ-flavored, extracted by
 * `src/io/crs.ts`) into a `ResolvedCrs`. The conversion is
 * mechanical — no inference, no override, no confidence-mixing.
 * Higher layers (`CrsDetection.ts`) combine multiple sources and
 * decide the final confidence.
 *
 * Returns `null` when `info` is `undefined` so callers can chain it
 * without a guard.
 */
export function resolvedFromCrsInfo(
  info: CrsInfo | undefined,
  source: CrsSource,
): ResolvedCrs | null {
  if (!info) return null;
  const kind: CrsKind = info.isGeographic ? 'geographic' : 'projected';
  // Confidence: EPSG + WKT = high, EPSG OR a recognisable name = medium.
  // The CrsInfo always has a `name`, so the discriminator is EPSG.
  const confidence: CrsConfidence =
    typeof info.epsg === 'number' && info.wkt
      ? 'high'
      : typeof info.epsg === 'number' || info.name.startsWith('EPSG:')
        ? 'medium'
        : 'low';
  return {
    kind,
    name: info.name,
    epsg: info.epsg,
    linearUnit: info.linearUnit,
    linearUnitToMetres: info.linearUnitToMetres,
    source,
    confidence,
    userConfirmed: false,
    wkt: info.wkt,
    verticalEpsg: info.verticalEpsg,
    verticalDatum: info.verticalDatum,
    verticalUnitToMetres: info.verticalUnitToMetres,
    // The WKT-declared datum (realization-preserving). CrsService fills the
    // registry fallback by EPSG when this is absent — kept out of here to avoid
    // a CoordinateTypes → CrsRegistry import cycle.
    horizontalDatum: info.horizontalDatum,
  };
}

/**
 * A `ResolvedCrs` for the explicit local-coordinates case. Returned
 * for phone scans, raw scanner output, and any dataset that
 * deliberately has no CRS.
 */
export function localCrs(): ResolvedCrs {
  return {
    kind: 'local',
    name: 'Local coordinates (no CRS)',
    linearUnit: 'unknown',
    linearUnitToMetres: 1,
    source: 'default-assumption',
    confidence: 'high', // we're explicitly saying "this has no CRS"
    userConfirmed: false,
  };
}

/**
 * A `ResolvedCrs` for the explicit unknown case. Returned when no
 * detection signal was available and no user override is in place.
 * Distinct from `localCrs()`: this is "we don't know yet", while
 * `localCrs()` is "we explicitly have no CRS".
 */
export function unknownCrs(): ResolvedCrs {
  return {
    kind: 'unknown',
    name: 'CRS unknown',
    linearUnit: 'unknown',
    linearUnitToMetres: 1,
    source: 'default-assumption',
    confidence: 'none',
    userConfirmed: false,
  };
}
