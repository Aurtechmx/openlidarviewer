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
  /** Volumes (m³) over comparable cells: gain (Δ>0), loss (Δ<0), and net = gain − loss. */
  readonly gainVolumeM3: number;
  readonly lossVolumeM3: number;
  readonly netVolumeM3: number;
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
  const cellArea = cellSizeM * cellSizeM;

  const diff = new Float32Array(W * H);
  const classes = new Int8Array(W * H);

  let comparable = 0;
  let gained = 0;
  let lost = 0;
  let gainVolumeM3 = 0;
  let lossVolumeM3 = 0;
  let absSum = 0;
  let maxGainM = 0;
  let maxLossM = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const av = a.values[y * a.width + x];
      const bv = b.values[y * b.width + x];
      const oi = y * W + x;
      if (!Number.isFinite(av) || !Number.isFinite(bv)) {
        diff[oi] = NaN;
        classes[oi] = 0;
        continue;
      }
      const d = bv - av;
      diff[oi] = d;
      comparable++;
      absSum += Math.abs(d);
      if (d > maxGainM) maxGainM = d;
      if (d < maxLossM) maxLossM = d;
      // Volumes count ONLY significant (above-LoD) cells — a DEM-of-difference
      // thresholds out the noise floor so sub-LoD jitter never inflates cut/fill.
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
    meanAbsChangeM: comparable > 0 ? absSum / comparable : 0,
    maxGainM,
    maxLossM,
  };

  if (comparable === 0) {
    warnings.push('No cells are populated in both epochs — nothing to compare.');
  }

  return { diff, classes, width: W, height: H, cellSizeM, stats, aligned, warnings };
}
