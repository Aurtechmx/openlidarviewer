/**
 * terrainDerivatives.ts
 *
 * Pure-data leaf — first-order terrain derivatives (slope and
 * aspect) computed with Horn's 3x3 method, the same estimator ArcGIS and
 * GDAL use. It replaces the previous crude "largest absolute drop to a
 * 4-neighbour" slope, which was anisotropic (it over-reported slope along
 * the axes and under-reported it on the diagonals) and had no aspect.
 *
 * Horn (1981) fits a plane to the 3x3 neighbourhood with a weighted
 * central difference. GRID CONVENTION: our rasters are NORTHING-UP —
 * `rasterizeDtm` maps row = floor((y − origin) / cell), so row+1 is one
 * cell NORTH (unlike image rasters, where row+1 is south). Hence:
 *
 *   dz/dx = ((zE + 2·zE + zE) − (zW + 2·zW + zW)) / (8·cell)   [weighted]
 *   dz/dy = ((zN + 2·zN + zN) − (zS + 2·zS + zS)) / (8·cell)   [= +∂z/∂northing]
 *   slope = hypot(dz/dx, dz/dy)            (rise/run, dimensionless)
 *   aspect = atan2(−dz/dy, −dz/dx)         (radians, math frame, downslope)
 *
 * Aspect is the DOWNSLOPE direction −∇z = (−dz/dx, −dz/dy) expressed as a
 * math-frame angle (CCW from east; π/2 = north). Because dz/dy here is
 * +∂z/∂northing, BOTH components must be negated — the ESRI textbook form
 * atan2(dz/dy, −dz/dx) assumes image rows (row+1 = south) and mirrored our
 * aspect north–south (v0.4.3 bug: hillshade lit the wrong flank).
 *
 * The weighting (corners 1, edges 2) makes the estimate isotropic and
 * smooths single-cell noise — which is exactly what the confidence
 * roughness term and any future hillshade need.
 *
 * Border cells replicate the edge (clamp), and any non-finite neighbour
 * falls back to the centre value, so the result is finite wherever the
 * centre cell is finite. Deterministic. No DOM, no three.js, no I/O.
 */

/** Slope (rise/run) and aspect (radians) per cell, row-major. */
export interface TerrainDerivatives {
  /** Slope as rise/run (dimensionless). 0 on flat ground. */
  readonly slope: Float32Array;
  /**
   * Aspect in radians — the DOWNSLOPE direction in the math frame (CCW from
   * east; π/2 = north), atan2(−dz/dy, −dz/dx) on the northing-up grid.
   * 0 where slope is ~0.
   */
  readonly aspect: Float32Array;
}

/**
 * Compute Horn slope + aspect over a row-major elevation grid. Cells
 * whose centre is non-finite yield slope 0 / aspect 0 (no surface to
 * differentiate). `cellSizeM` must be > 0; otherwise slope is 0 grid-wide.
 */
export function hornSlopeAspect(
  z: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
): TerrainDerivatives {
  const n = cols * rows;
  const slope = new Float32Array(n);
  const aspect = new Float32Array(n);
  if (n === 0 || !(cellSizeM > 0)) return { slope, aspect };

  const at = (r: number, c: number, fallback: number): number => {
    const rr = r < 0 ? 0 : r >= rows ? rows - 1 : r;
    const cc = c < 0 ? 0 : c >= cols ? cols - 1 : c;
    const v = z[rr * cols + cc];
    return Number.isFinite(v) ? v : fallback;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const e = z[i];
      if (!Number.isFinite(e)) {
        slope[i] = 0;
        aspect[i] = 0;
        continue;
      }
      // 3x3 neighbourhood (a b c / d e f / g h i), edge-clamped, NaN→centre.
      const a = at(row - 1, col - 1, e);
      const b = at(row - 1, col, e);
      const c = at(row - 1, col + 1, e);
      const d = at(row, col - 1, e);
      const f = at(row, col + 1, e);
      const g = at(row + 1, col - 1, e);
      const h = at(row + 1, col, e);
      const ii = at(row + 1, col + 1, e);

      // Northing-up grid: row+1 (g, h, ii) is NORTH, row−1 (a, b, c) is
      // south, so dzdy is +∂z/∂northing.
      const dzdx = (c + 2 * f + ii - (a + 2 * d + g)) / (8 * cellSizeM);
      const dzdy = (g + 2 * h + ii - (a + 2 * b + c)) / (8 * cellSizeM);
      slope[i] = Math.hypot(dzdx, dzdy);
      // Aspect = downslope direction −∇z in the math frame: negate BOTH
      // gradient components. atan2(+dzdy, −dzdx) (the image-row ESRI form)
      // mirrored aspect north–south on this northing-up grid.
      aspect[i] = dzdx === 0 && dzdy === 0 ? 0 : Math.atan2(-dzdy, -dzdx);
    }
  }
  return { slope, aspect };
}

/** Convenience: just the slope grid (rise/run). */
export function hornSlope(
  z: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
): Float32Array {
  return hornSlopeAspect(z, cols, rows, cellSizeM).slope;
}
