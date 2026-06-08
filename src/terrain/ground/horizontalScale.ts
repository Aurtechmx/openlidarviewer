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
