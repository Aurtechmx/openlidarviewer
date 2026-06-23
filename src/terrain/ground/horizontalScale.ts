/**
 * horizontalScale.ts
 *
 * Helper for turning a grid cell size into metres. When the horizontal frame
 * is geographic the cell size is in degrees, so slope/roughness derivatives
 * (which divide a metric ΔZ by the cell size) need the cell converted to
 * metres or they read as near-vertical. Projected data passes through.
 */

/** Mean metres per degree of latitude (WGS84 mean; longitude varies by cos φ). */
export const METRES_PER_DEGREE = 111_320;

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
 * in DEGREES but NOT in metres: 1° of latitude is ~{@link METRES_PER_DEGREE} m
 * everywhere, but 1° of longitude is that × `cos(latitude)`. Feeding one scalar
 * to a slope estimator therefore overstates the east–west run by `1/cos φ` and
 * skews slope/aspect off the equator. This returns both axes so the estimator
 * can scale dz/dx and dz/dy independently.
 *
 * Projected frames are isotropic: both axes are `cellSizeM × horizontalUnitToMetres`.
 *
 * @param latitudeDeg Representative latitude of the grid (e.g. its centre), in
 *   degrees. Only consulted for geographic frames.
 */
export function horizontalCellMetresXY(
  cellSizeM: number,
  isGeographic: boolean | undefined,
  latitudeDeg = 0,
  horizontalUnitToMetres = 1,
): CellMetresXY {
  if (isGeographic) {
    const y = cellSizeM * METRES_PER_DEGREE;
    const cosLat = Math.max(0, Math.cos((latitudeDeg * Math.PI) / 180));
    return { x: y * cosLat, y };
  }
  const scale =
    Number.isFinite(horizontalUnitToMetres) && horizontalUnitToMetres > 0
      ? horizontalUnitToMetres
      : 1;
  const m = cellSizeM * scale;
  return { x: m, y: m };
}
