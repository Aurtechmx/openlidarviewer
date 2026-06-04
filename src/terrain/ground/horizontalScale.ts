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
 * when the frame is geographic; otherwise returns the cell size unchanged.
 */
export function horizontalCellMetres(cellSizeM: number, isGeographic?: boolean): number {
  return isGeographic ? cellSizeM * METRES_PER_DEGREE : cellSizeM;
}
