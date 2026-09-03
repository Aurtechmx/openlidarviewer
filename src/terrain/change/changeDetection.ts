/**
 * changeDetection.ts
 *
 * Two-epoch terrain change detection — the pure math behind an A/B compare
 * ("how does this week's scan differ from last week's"). Given two DTM grids on
 * the SAME raster, it computes a per-cell elevation difference (b − a, so
 * positive = accretion / gain, negative = erosion / loss), classifies each cell
 * against a Level-of-Detection threshold, and reduces it to cut/fill volumes
 * and a change-significance summary.
 *
 * HONESTY CONTRACT (non-negotiable — change detection is the easiest analysis to
 * mislead with):
 *   - Co-registration is the user's responsibility. If the two grids are not on
 *     a common raster (same cell size + dimensions), the result is flagged
 *     `aligned: false` with a loud warning, because a cell-for-cell subtraction
 *     of misaligned grids measures misalignment, not change.
 *   - A difference within ±`levelOfDetection` is reported as NO CHANGE, not a
 *     tiny real change — below the survey's own noise floor, the sign is
 *     meaningless.
 *   - A cell that is empty in either epoch is incomparable (NaN), never 0.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. The wipe-slider UI that
 * visualises this is a separate, browser-verified layer.
 */

/** A regular elevation grid. `values[y*width + x]` in metres; NaN = empty cell. */
export interface ChangeGrid {
  readonly width: number;
  readonly height: number;
  /** Cell size in metres (square cells). */
  readonly cellSizeM: number;
  readonly values: Float32Array;
}

export interface ChangeDetectionOptions {
  /**
   * Level of Detection (metres) — the minimum elevation difference that counts
   * as real change. Differences with |Δ| ≤ this are classified "no change"
   * (below the noise floor). Default 0.1 m.
   */
  readonly levelOfDetectionM?: number;
  /**
   * Horizontal CRS unit → metres (1 for a metre CRS, ~0.3048 for feet). The
   * grids' `cellSizeM` is in the source CRS's units, so without this the cell
   * AREA — and therefore every cut/fill volume — is in source-unit², not m².
   * Default 1. Geographic (degree) grids can't be volumed and should not be
   * passed here.
   */
  readonly horizontalUnitToMetres?: number;
  /**
   * Vertical unit → metres for the elevation difference (defaults to the
   * horizontal factor). Without it the Level-of-Detection (in metres) is
   * compared against a source-unit Δz, and the extremes/mean are in source
   * units. Default = horizontal factor.
   */
  readonly verticalUnitToMetres?: number;
}

/** Per-cell change class. 0 = no change / incomparable, +1 = gain, −1 = loss. */
export type ChangeClass = 0 | 1 | -1;

export interface ChangeStats {
  /** Cells in the compared region (the common sub-rectangle). */
  readonly cells: number;
  /** Cells finite in BOTH epochs (the only ones that yield a difference). */
  readonly comparable: number;
  /** Comparable cells classified as gain / loss / unchanged. */
  readonly gained: number;
  readonly lost: number;
  readonly unchanged: number;
  /** Fraction of comparable cells that changed significantly, 0..1. */
  readonly significantFraction: number;
  /**
   * Volumes (m³) over ABOVE-LoD cells only: gain (Δ>+LoD), loss (Δ<−LoD), and
   * net = gain − loss. Thresholding is the right call for GROSS erosion/
   * deposition (Anderson, USGS pubs.usgs.gov/publication/70202166 — noise
   * inflates both sides equally, so dropping sub-LoD cells removes it), but
   * applying the SAME threshold to the NET is a bias: uncorrelated random
   * error that would cancel in a raw sum survives here because opposite-sign
   * sub-LoD cells are both zeroed out before they can offset each other. Use
   * {@link rawNetVolumeM3} for the net figure; these three remain exactly the
   * legacy `olv.change.dtm-difference@1` quantities and are NOT redefined.
   */
  readonly gainVolumeM3: number;
  readonly lossVolumeM3: number;
  readonly netVolumeM3: number;
  /**
   * Net volume (m³) summed over EVERY comparable cell (no LoD threshold):
   * Σ Δz·cellArea. Per Anderson, this is the statistically correct net —
   * uncorrelated sub-LoD noise of both signs is free to cancel, instead of
   * being clipped to zero on one side only. This is the primary net figure
   * (`olv.change.dtm-difference.raw-net@1`); `netVolumeM3` above is kept
   * for `@1` provenance.
   */
  readonly rawNetVolumeM3: number;
  /** Alias of {@link gainVolumeM3} under `.raw-net@1` (above-LoD gain). */
  readonly detectableGainVolumeM3: number;
  /** Alias of {@link lossVolumeM3} under `.raw-net@1` (above-LoD loss). */
  readonly detectableLossVolumeM3: number;
  /** Alias of {@link netVolumeM3} under `.raw-net@1` (thresholded net, for gross/net comparison). */
  readonly detectableNetVolumeM3: number;
  /** Fraction of comparable cells whose |Δ| exceeds the LoD (same value as {@link significantFraction}, named for `@2`'s gross/net reconciliation). */
  readonly areaAboveLoDFraction: number;
  /** Mean |Δ| over comparable cells (m). */
  readonly meanAbsChangeM: number;
  /** Signed extremes (m): largest gain (≥0) and largest loss (≤0). */
  readonly maxGainM: number;
  readonly maxLossM: number;
}

export interface ChangeResult {
  /** b − a per cell over the compared region; NaN where either epoch is empty. */
  readonly diff: Float32Array;
  /** Per-cell {@link ChangeClass}. */
  readonly classes: Int8Array;
  readonly width: number;
  readonly height: number;
  readonly cellSizeM: number;
  readonly stats: ChangeStats;
  /** True only when both grids shared cell size AND dimensions. */
  readonly aligned: boolean;
  /** Honest caveats (mis-registration, partial overlap, …). */
  readonly warnings: readonly string[];
}

/** Default Level-of-Detection (m): changes with |Δ| ≤ this read as no change. */
export const DEFAULT_LOD_M = 0.1;

/**
 * Compare two DTM grids (epoch `a` = before, `b` = after). Both should be on the
 * same raster; when they are not, the comparison runs over the overlapping
 * top-left sub-rectangle and the result is flagged `aligned: false`.
 */
export function detectChange(
  a: ChangeGrid,
  b: ChangeGrid,
  options: ChangeDetectionOptions = {},
): ChangeResult {
  const lod = Math.max(0, options.levelOfDetectionM ?? DEFAULT_LOD_M);
  const warnings: string[] = [];

  const sameDims = a.width === b.width && a.height === b.height;
  const sameCell = Math.abs(a.cellSizeM - b.cellSizeM) < 1e-9;
  const aligned = sameDims && sameCell;
  if (!sameCell) {
    warnings.push(
      `Epochs use different cell sizes (${a.cellSizeM} m vs ${b.cellSizeM} m) — ` +
        `resample both to one raster before comparing; differences below assume ` +
        `cell-for-cell correspondence and may reflect resolution, not change.`,
    );
  }
  if (!sameDims) {
    warnings.push(
      `Epochs have different dimensions (${a.width}×${a.height} vs ${b.width}×${b.height}) — ` +
        `compared over the overlapping ${Math.min(a.width, b.width)}×${Math.min(a.height, b.height)} ` +
        `region only.`,
    );
  }

  const W = Math.min(a.width, b.width);
  const H = Math.min(a.height, b.height);
  const cellSizeM = a.cellSizeM; // report in epoch-a units (warned if they differ)
  // CRS-unit → metres so cut/fill is m³ and the elevation difference is metres
  // (the LoD is in metres). `cellSizeM` is in the source CRS's units; for a
  // foot CRS, hM ≈ 0.3048 makes the cell area m² and vM scales Δz to metres.
  const hM = Number.isFinite(options.horizontalUnitToMetres) && (options.horizontalUnitToMetres as number) > 0
    ? (options.horizontalUnitToMetres as number)
    : 1;
  const vM = Number.isFinite(options.verticalUnitToMetres) && (options.verticalUnitToMetres as number) > 0
    ? (options.verticalUnitToMetres as number)
    : hM;
  const cellArea = (cellSizeM * hM) * (cellSizeM * hM);

  const diff = new Float32Array(W * H);
  const classes = new Int8Array(W * H);

  let comparable = 0;
  let gained = 0;
  let lost = 0;
  let gainVolumeM3 = 0;
  let lossVolumeM3 = 0;
  let rawNetVolumeM3 = 0;
  let absSum = 0;
  let maxGainM = 0;
  let maxLossM = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const av = a.values[y * a.width + x];
      const bv = b.values[y * b.width + x];
      const oi = y * W + x;
      if (!Number.isFinite(av) || !Number.isFinite(bv)) {
        diff[oi] = Number.NaN;
        classes[oi] = 0;
        continue;
      }
      const d = (bv - av) * vM; // elevation difference in metres
      diff[oi] = d;
      comparable++;
      absSum += Math.abs(d);
      if (d > maxGainM) maxGainM = d;
      if (d < maxLossM) maxLossM = d;
      // rawNetVolumeM3 integrates EVERY comparable cell, thresholded or not —
      // the correct net estimator (Anderson, USGS pubs.usgs.gov/publication/70202166):
      // uncorrelated sub-LoD noise of both signs is free to cancel here, unlike
      // the thresholded gain/loss volumes below.
      rawNetVolumeM3 += d * cellArea;
      // Detectable (above-LoD) gain/loss volumes — correct for GROSS
      // erosion/deposition, where thresholding out the noise floor stops
      // sub-LoD jitter from inflating cut/fill in either direction.
      if (d > lod) { classes[oi] = 1; gained++; gainVolumeM3 += d * cellArea; }
      else if (d < -lod) { classes[oi] = -1; lost++; lossVolumeM3 += -d * cellArea; }
      else classes[oi] = 0;
    }
  }

  const unchanged = comparable - gained - lost;
  const stats: ChangeStats = {
    cells: W * H,
    comparable,
    gained,
    lost,
    unchanged,
    significantFraction: comparable > 0 ? (gained + lost) / comparable : 0,
    gainVolumeM3,
    lossVolumeM3,
    netVolumeM3: gainVolumeM3 - lossVolumeM3,
    rawNetVolumeM3,
    detectableGainVolumeM3: gainVolumeM3,
    detectableLossVolumeM3: lossVolumeM3,
    detectableNetVolumeM3: gainVolumeM3 - lossVolumeM3,
    areaAboveLoDFraction: comparable > 0 ? (gained + lost) / comparable : 0,
    meanAbsChangeM: comparable > 0 ? absSum / comparable : 0,
    maxGainM,
    maxLossM,
  };

  if (comparable === 0) {
    warnings.push('No cells are populated in both epochs — nothing to compare.');
  }

  return { diff, classes, width: W, height: H, cellSizeM, stats, aligned, warnings };
}
