/**
 * horizontalScale.ts
 *
 * Helper for turning a grid cell size into metres. When the horizontal frame
 * is geographic the cell size is in degrees, so slope/roughness derivatives
 * (which divide a metric ΔZ by the cell size) need the cell converted to
 * metres or they read as near-vertical. Projected data passes through.
 */

/**
 * Mean length of one degree of latitude on the WGS84 ellipsoid: the meridian
 * quadrant (10 001 965.729 m) divided by 90, ≈ 111 132.95 m.
 *
 * Used only where no latitude is available (cell-size floors, isotropic
 * fallbacks). Where the grid latitude is known, convert each axis with
 * {@link metresPerDegreeLatitude} and {@link metresPerDegreeLongitude}: the
 * true meridional degree runs from 110 574 m at the equator to 111 694 m at
 * the poles, and a degree of longitude is 111 319 m only at the equator.
 * (The previous value, 111 320 m, was the equatorial degree of LONGITUDE.)
 */
export const METRES_PER_DEGREE = 10_001_965.729 / 90;

/**
 * Names the degree-to-metre model this module applies to a geographic frame:
 * the WGS84 meridional and parallel degree series below, at the grid
 * latitude. Recorded in identities that depend on the conversion (the Terrain
 * Access input digest) so a change of model changes the identity. Change it
 * together with the series.
 */
export const GEOGRAPHIC_DEGREE_MODEL = 'wgs84-degree-series';

/**
 * Metres per degree of LATITUDE (north–south) on the WGS84 ellipsoid at
 * geodetic latitude φ, from the standard series
 * `111132.92 − 559.82 cos 2φ + 1.175 cos 4φ − 0.0023 cos 6φ`
 * (≈ 110 574 m at the equator, 111 694 m at the poles). A null or non-finite
 * latitude returns the mean {@link METRES_PER_DEGREE}.
 */
export function metresPerDegreeLatitude(latitudeDeg: number | null | undefined): number {
  if (latitudeDeg == null || !Number.isFinite(latitudeDeg)) return METRES_PER_DEGREE;
  const phi = (Math.max(-90, Math.min(90, latitudeDeg)) * Math.PI) / 180;
  return (
    111_132.92 -
    559.82 * Math.cos(2 * phi) +
    1.175 * Math.cos(4 * phi) -
    0.0023 * Math.cos(6 * phi)
  );
}

/**
 * Metres per degree of LONGITUDE (east–west) on the WGS84 ellipsoid at
 * geodetic latitude φ, from the standard series
 * `111412.84 cos φ − 93.5 cos 3φ + 0.118 cos 5φ`
 * (≈ 111 319 m at the equator, 194.9 m at 89.9°). It is the scale at φ itself:
 * φ is limited only to the valid range ±90°, never moved to another latitude.
 * Products that divide by a cell's east–west size check the latitude against
 * {@link MAX_GEOGRAPHIC_LATITUDE_DEG} first ({@link geographicLatitudeRefusal}).
 * A null or non-finite latitude returns the mean {@link METRES_PER_DEGREE},
 * the isotropic fallback (no E–W correction) used when φ is unknown.
 */
export function metresPerDegreeLongitude(latitudeDeg: number | null | undefined): number {
  if (latitudeDeg == null || !Number.isFinite(latitudeDeg)) return METRES_PER_DEGREE;
  const phi = (Math.max(-90, Math.min(90, latitudeDeg)) * Math.PI) / 180;
  return 111_412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
}

/**
 * Highest absolute latitude at which a geographic grid's slope, aspect,
 * hillshade, cell sizes and the products built on them are computed. Above it
 * a degree of longitude shrinks so fast across a footprint that one
 * representative latitude cannot stand for the grid (at 89.9° the E–W scale
 * changes by 1 % over 0.0006° of latitude), and the scan needs a polar
 * projected CRS instead.
 */
export const MAX_GEOGRAPHIC_LATITUDE_DEG = 89;

/** A geographic grid beyond {@link MAX_GEOGRAPHIC_LATITUDE_DEG}: its metric derivatives are withheld. */
export class GeographicLatitudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeographicLatitudeError';
  }
}

/**
 * Why metric derivatives of a geographic grid at `latitudeDeg` are withheld, or
 * null when the latitude is within the supported domain (or unknown, which has
 * its own isotropic fallback and warning).
 */
export function geographicLatitudeRefusal(latitudeDeg: number | null | undefined): string | null {
  if (latitudeDeg == null || !Number.isFinite(latitudeDeg)) return null;
  if (Math.abs(latitudeDeg) <= MAX_GEOGRAPHIC_LATITUDE_DEG) return null;
  return (
    `This scan's coordinates are geographic (degrees) at latitude ${latitudeDeg.toFixed(3)}°, beyond the ±${MAX_GEOGRAPHIC_LATITUDE_DEG}° ` +
    'within which a degree of longitude can be converted to metres for one representative latitude. Slope, aspect, ' +
    'cell sizes and the products built on them are withheld. Reproject the scan to a polar projected CRS ' +
    '(for example EPSG:3413 or EPSG:3031) and open it again.'
  );
}

/**
 * Throw {@link GeographicLatitudeError} for a geographic grid beyond the
 * supported latitude. Called before any work that divides by a cell size.
 */
export function assertGeographicLatitudeSupported(isGeographic: boolean | undefined, latitudeDeg: number | null | undefined): void {
  const refusal = isGeographic ? geographicLatitudeRefusal(latitudeDeg) : null;
  if (refusal) throw new GeographicLatitudeError(refusal);
}

/**
 * cos(latitude) for the east–west metres-per-degree scale, at φ itself (limited
 * only to ±90°). Non-finite latitudes return 1 (no correction — the honest
 * isotropic fallback), so a caller that cannot resolve a representative
 * latitude degrades gracefully instead of guessing one (or poisoning the scale
 * with NaN).
 */
export function cosLatitude(latitudeDeg: number | null | undefined): number {
  if (latitudeDeg == null || !Number.isFinite(latitudeDeg)) return 1;
  const lat = Math.max(-90, Math.min(90, latitudeDeg));
  return Math.cos((lat * Math.PI) / 180);
}

/**
 * Horizontal cell size in metres. Converts a degree-denominated cell to metres
 * when the frame is geographic; for a projected frame it scales by
 * `horizontalUnitToMetres` (1 for metre data, ~0.3048 for US/international feet)
 * so slope/roughness derivatives and cell areas are correct for feet-based CRSs.
 * Default 1 leaves metric projected data unchanged.
 */
export function horizontalCellMetres(
  cellSizeM: number,
  isGeographic?: boolean,
  horizontalUnitToMetres = 1,
): number {
  const scale =
    Number.isFinite(horizontalUnitToMetres) && horizontalUnitToMetres > 0
      ? horizontalUnitToMetres
      : 1;
  return isGeographic ? cellSizeM * METRES_PER_DEGREE : cellSizeM * scale;
}

/** Per-axis horizontal cell size in metres (east/west X, north/south Y). */
export interface CellMetresXY {
  /** East–west (longitude / column) cell size in metres. */
  readonly x: number;
  /** North–south (latitude / row) cell size in metres. */
  readonly y: number;
}

/**
 * Per-axis cell size in metres. A geographic (lat/lon) raster has square cells
 * in DEGREES but NOT in metres: 1° of latitude is
 * {@link metresPerDegreeLatitude} (110 574 to 111 694 m on WGS84), and 1° of
 * longitude is {@link metresPerDegreeLongitude}, roughly that × `cos(latitude)`.
 * Feeding one scalar
 * to a slope estimator therefore overstates the east–west run by `1/cos φ` and
 * skews slope/aspect off the equator. This returns both axes so the estimator
 * can scale dz/dx and dz/dy independently.
 *
 * Projected frames are isotropic: both axes are `cellSizeM × horizontalUnitToMetres`.
 *
 * @param latitudeDeg Representative latitude of the grid (e.g. its centre), in
 *   degrees. Only consulted for geographic frames. Null/undefined/non-finite
 *   means "unknown" — both axes then use the mean {@link METRES_PER_DEGREE}
 *   (isotropic, no E–W correction) rather than inventing a latitude.
 */
export function horizontalCellMetresXY(
  cellSizeM: number,
  isGeographic: boolean | undefined,
  latitudeDeg: number | null | undefined = 0,
  horizontalUnitToMetres = 1,
): CellMetresXY {
  if (isGeographic) {
    // Ellipsoidal degree lengths at the grid latitude: the meridional degree
    // for N–S, the parallel degree for E–W. Beyond the supported latitude no
    // length is returned: substituting another latitude would change every
    // slope. A non-finite latitude falls back to the isotropic mean instead of
    // poisoning every derivative with NaN.
    const refusal = geographicLatitudeRefusal(latitudeDeg);
    if (refusal) throw new GeographicLatitudeError(refusal);
    return {
      x: cellSizeM * metresPerDegreeLongitude(latitudeDeg),
      y: cellSizeM * metresPerDegreeLatitude(latitudeDeg),
    };
  }
  const scale =
    Number.isFinite(horizontalUnitToMetres) && horizontalUnitToMetres > 0
      ? horizontalUnitToMetres
      : 1;
  const m = cellSizeM * scale;
  return { x: m, y: m };
}
