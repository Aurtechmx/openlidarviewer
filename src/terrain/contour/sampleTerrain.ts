/**
 * sampleTerrain.ts
 *
 * Read the analysed terrain at a single DTM cell — bare-earth elevation, slope,
 * and above-ground (canopy) height. The Analyse panel calls this when the user
 * clicks a preview raster, turning the static surface into a point-query tool
 * (the QGIS "Point Sampling Tool" idea, scoped to the grids we already hold).
 *
 * Pure-data: takes the grids it needs structurally, so it is unit-testable with
 * tiny fixtures and works directly on an AnalyseContoursResult.
 */

export interface TerrainSample {
  readonly col: number;
  readonly row: number;
  /** True when the DTM has a (measured or interpolated) value at this cell. */
  readonly covered: boolean;
  /** Bare-earth DTM elevation in source vertical units, NaN if uncovered. */
  readonly elevationM: number;
  /** Slope in degrees, NaN if uncovered/undefined. */
  readonly slopeDeg: number;
  /** Above-ground (canopy/structure) height in metres, NaN if none. */
  readonly canopyM: number;
}

/** The minimal grid surface `sampleTerrain` needs — an AnalyseContoursResult fits. */
export interface SampleableTerrain {
  readonly dtm: {
    readonly z: ArrayLike<number>;
    readonly coverage: ArrayLike<number>;
    readonly cols: number;
    readonly rows: number;
  };
  readonly surface: {
    readonly relief: { readonly slope: ArrayLike<number> };
    readonly canopy: { readonly heightM: ArrayLike<number> };
  };
}

/**
 * Sample the terrain at grid cell (col, row). Returns null when the cell is
 * outside the grid. `slope` is stored as a tangent (dz/dl); we convert to
 * degrees here for display.
 */
export function sampleTerrain(
  t: SampleableTerrain,
  col: number,
  row: number,
): TerrainSample | null {
  const { dtm, surface } = t;
  if (col < 0 || row < 0 || col >= dtm.cols || row >= dtm.rows) return null;
  const i = row * dtm.cols + col;

  const covered = dtm.coverage[i] !== 0;
  const z = dtm.z[i];
  const elevationM = covered && Number.isFinite(z) ? z : Number.NaN;

  const slopeTan = surface.relief.slope[i];
  const slopeDeg =
    covered && Number.isFinite(slopeTan) ? (Math.atan(slopeTan) * 180) / Math.PI : Number.NaN;

  const canopyRaw = surface.canopy.heightM[i];
  const canopyM = Number.isFinite(canopyRaw) ? canopyRaw : Number.NaN;

  return { col, row, covered, elevationM, slopeDeg, canopyM };
}
