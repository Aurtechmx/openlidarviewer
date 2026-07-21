/**
 * surfaceFromRaster.ts
 *
 * THE one raster→grid constructor for the delivered DTM surface. Both the
 * live pipeline (`analyseContours.computeTerrainCore`) and the hold-out
 * validation (`holdoutRmse.holdoutValidateDtm`) build their surface through
 * this function, so the surface the validation measures is constructed with
 * the SAME despike pass, the SAME extrapolation guard, and the SAME unit
 * parameters as the surface the user receives.
 *
 * Before v0.4.5 the hold-out path skipped the despike and the extrapolation
 * guard and dropped the horizontal-unit scale (v0.4.3 audit finding: "hold-out
 * validation builds a different surface than the live one — the confidence
 * calibration is fit on mismatched data"). Centralising the construction here
 * makes that divergence structurally impossible.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { DemRaster } from './rasterizeDtm';
import { buildDtmGrid, type DtmGrid } from './cellConfidence';
import { removeSpikes } from './despike';

/** Void-fill method every production surface is built with (provenance). */
export const LIVE_INTERPOLATION = 'geodesic' as const;

/**
 * Extrapolation guard every production surface is built with: one-sided
 * (extrapolated) fills are demoted toward dashed/gap so surface supported
 * from a single direction can't read as confident.
 */
export const LIVE_EXTRAPOLATION_GUARD = { radiusCells: 8, penalty: 0.5 } as const;

/**
 * Blunder-only despike thresholds (6σ MAD, ≥ 30 cm absolute) — conservative so
 * legitimate small features in flat terrain are kept; only gross outliers go.
 */
export const LIVE_DESPIKE = { madThreshold: 6, minDeviationM: 0.3 } as const;

export interface SurfaceFromRasterParams {
  /** Horizontal CRS, passed through to the grid. */
  readonly crs?: string | null;
  /** Numeric EPSG codes from the resolver, passed through to the grid. */
  readonly horizontalEpsg?: number | null;
  readonly verticalEpsg?: number | null;
  /** Vertical datum, passed through to the grid. */
  readonly verticalDatum?: string | null;
  /** True when the horizontal frame is geographic (degree cells). */
  readonly isGeographic?: boolean;
  /**
   * WORLD grid-centre latitude (degrees) for the geographic cos φ E–W scale.
   * The raster's own origin is render-recentred (≈ 0), so only the caller —
   * who knows the cloud's world origin — can supply the real latitude.
   * Null / omitted falls back to the raster-origin estimate (correct only
   * for un-recentred grids).
   */
  readonly latitudeDeg?: number | null;
  /** Metres per source horizontal unit (~0.3048 for feet). Default 1. */
  readonly horizontalUnitToMetres?: number;
  /** Metres per source vertical unit (~0.3048 for feet); scales the roughness
   *  slope's rise to metres. Default 1. */
  readonly verticalUnitToMetres?: number;
  /** Density (returns/cell) earning full confidence; default = scene median. */
  readonly targetCount?: number;
}

export interface SurfaceFromRasterResult {
  /** The finished grid (despiked raster → geodesic fill → guarded confidence). */
  readonly dtm: DtmGrid;
  /** The raster the grid was built from (despiked copy, or the input as-is). */
  readonly raster: DemRaster;
  /** Outlier cells actually removed (0 when none, or when the cap engaged). */
  readonly despikedCellCount: number;
  /**
   * Outlier cells flagged but LEFT IN PLACE because they exceeded the 2 %
   * safety cap — that much "spike" is noise, and removing it would distort
   * the surface. 0 when the despike applied (or found nothing).
   */
  readonly cappedOutlierCount: number;
}

/**
 * Build the delivered DTM grid from a rasterised DEM: blunder-only despike
 * (with the 2 % safety cap), then `buildDtmGrid` with the production
 * interpolation + extrapolation guard + unit parameters. Identical inputs ⇒
 * identical surface, wherever it is called from.
 */
export function buildSurfaceFromRaster(
  raster: DemRaster,
  params: SurfaceFromRasterParams = {},
): SurfaceFromRasterResult {
  // DTM hardening — drop blunder cells (a lone ground return far from its
  // neighbours) so they don't warp the surface; the builder re-fills them by
  // interpolation. Real outliers only — smooth terrain loses nothing.
  let workingRaster = raster;
  const hadData0 = new Uint8Array(raster.counts.length);
  let measuredCellCount = 0;
  for (let i = 0; i < hadData0.length; i++) {
    if (raster.counts[i] > 0) { hadData0[i] = 1; measuredCellCount++; }
  }
  const despiked = removeSpikes(raster.z, hadData0, raster.cols, raster.rows, LIVE_DESPIKE);
  // Safety cap: if "outliers" exceed 2% of measured cells the data is noisy,
  // not spiky — removing that much would distort the surface, so leave it.
  const removalCap = Math.max(4, Math.ceil(measuredCellCount * 0.02));
  let despikedCellCount = 0;
  let cappedOutlierCount = 0;
  if (despiked.removed > 0 && despiked.removed <= removalCap) {
    const counts2 = raster.counts.slice();
    let filled = 0;
    for (let i = 0; i < counts2.length; i++) {
      if (despiked.hadData[i] === 0) counts2[i] = 0;
      if (counts2[i] > 0) filled++;
    }
    workingRaster = { ...raster, z: despiked.z, counts: counts2, filledCellCount: filled };
    despikedCellCount = despiked.removed;
  } else if (despiked.removed > removalCap) {
    cappedOutlierCount = despiked.removed;
  }

  const dtm = buildDtmGrid(workingRaster, {
    crs: params.crs,
    horizontalEpsg: params.horizontalEpsg,
    verticalDatum: params.verticalDatum,
    verticalEpsg: params.verticalEpsg,
    targetCount: params.targetCount,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
    verticalUnitToMetres: params.verticalUnitToMetres,
    interpolation: LIVE_INTERPOLATION,
    extrapolationGuard: LIVE_EXTRAPOLATION_GUARD,
  });

  return { dtm, raster: workingRaster, despikedCellCount, cappedOutlierCount };
}
