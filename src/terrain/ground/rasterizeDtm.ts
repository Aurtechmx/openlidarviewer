/**
 * rasterizeDtm.ts
 *
 * Pure-data leaf. Turns classified ground returns into a raw
 * Digital Terrain Model raster: one elevation per grid cell, plus the
 * source-point count behind each cell. Empty cells stay `NaN` — this
 * module does NOT invent data. Inpainting and confidence are the job of
 * `cellConfidence.ts` (A3), which is where the honesty about
 * interpolated cells gets encoded.
 *
 * WHY a separate step from `groundFilter`. The SMRF filter produces a
 * provisional *opened* surface as a side effect of removing buildings;
 * that surface is an intermediate, not a deliverable DTM (it is biased
 * low by the morphological opening). The DTM the contours actually run
 * on is aggregated from the points the filter classified as ground —
 * keeping the two concerns separate means each is independently
 * testable and the contour surface is honest about its real samples.
 *
 * The raster aligns to a caller-supplied grid when one is given (so it
 * shares cell indices with the `groundFilter` result and the confidence
 * layer); otherwise it derives a grid from the ground points' extent.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainPoint, TerrainCoverageMode } from '../TerrainContracts';
import type { VerticalAxis } from './groundFilter';

/** A grid the raster should align to (e.g. the `groundFilter` grid). */
export interface GridSpec {
  readonly originH1: number;
  readonly originH2: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

/**
 * Per-cell aggregation strategy for ground returns.
 *
 * - `'mean'`   — arithmetic mean of the cell's returns (DEFAULT). Cheap and
 *                smooth but every outlier moves the result; one high return or
 *                one low blunder drags the cell elevation.
 * - `'min'`    — the lowest return in the cell. Resists high outliers
 *                (vegetation, parked vehicles) but is biased low and a single
 *                low blunder wins outright.
 * - `'median'` — the 50th percentile of the cell's returns. Resists BOTH high
 *                and low outliers (breakdown point 50 %); the canonical robust
 *                cell estimate.
 * - `'percentile'` — the value at fraction `p` (see {@link RasterizeDtmParams}).
 *                `p = 0` ≈ min, `p = 1` ≈ max, `p = 0.5` = median. A low `p`
 *                (e.g. 0.1) approximates a bare-earth surface while rejecting
 *                the single lowest blunder that pure `min` would take.
 * - `'robust'` — see below. A median-centred, MAD-clipped trimmed mean.
 */
export type DtmAggregation = 'mean' | 'min' | 'median' | 'percentile' | 'robust';

/** Options for {@link rasterizeDtm}. */
export interface RasterizeDtmParams {
  /** Cell size, source linear units. Ignored when `grid` is provided. */
  readonly cellSizeM?: number;
  /** Align to this grid instead of deriving one from the points. */
  readonly grid?: GridSpec;
  /** How to combine multiple ground returns in one cell. Default `mean`. */
  readonly aggregation?: DtmAggregation;
  /**
   * Percentile fraction for `aggregation: 'percentile'`, in [0, 1]. Default
   * 0.5 (median). Linear interpolation between order statistics (the same
   * "linear"/type-7 convention as NumPy's default), so `p = 0` returns the
   * minimum and `p = 1` the maximum. Ignored for other modes.
   */
  readonly percentile?: number;
  /** Vertical axis of the source frame. Default `'z'`. */
  readonly verticalAxis?: VerticalAxis;
}

/**
 * A raw DTM raster. `z[i]` is `NaN` for cells that received no ground
 * return — the honest "no data here" state. `counts[i]` is how many
 * ground returns landed in cell `i`.
 */
export interface DemRaster {
  readonly z: Float32Array;
  readonly counts: Uint32Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
  // ── honesty contract ──────────────────────────────────────────────
  readonly coverage: TerrainCoverageMode;
  /** Ground returns offered to the rasteriser. */
  readonly sourcePointCount: number;
  /** Ground returns that actually landed in a cell (finite coords). */
  readonly analyzedPointCount: number;
  /** Cells that received at least one ground return. */
  readonly filledCellCount: number;
  readonly warnings: string[];
}

function axes(p: TerrainPoint, v: VerticalAxis): readonly [number, number, number] {
  return v === 'y' ? [p.x, p.z, p.y] : [p.x, p.y, p.z];
}

/**
 * Rasterise the ground-classified subset of `points` into a DTM.
 *
 * `isGround` is the parallel mask from {@link classifyGroundSmrf}; only
 * returns with `isGround[i] === 1` contribute. Pass an all-ones mask to
 * rasterise every point.
 */
export function rasterizeDtm(
  points: ReadonlyArray<TerrainPoint>,
  isGround: Uint8Array | ReadonlyArray<number>,
  params: RasterizeDtmParams = {},
): DemRaster {
  const warnings: string[] = [];
  const vertical: VerticalAxis = params.verticalAxis ?? 'z';
  const aggregation: DtmAggregation = params.aggregation ?? 'mean';
  // mean/min aggregate with O(1) state per cell (running sum / running min);
  // median/percentile/robust need every value in the cell, so they buffer a
  // small per-cell list and reduce it once at the end.
  const needsLists =
    aggregation === 'median' || aggregation === 'percentile' || aggregation === 'robust';
  const percentile = aggregation === 'percentile' ? clampUnit(params.percentile ?? 0.5) : 0.5;

  // Collect the ground returns (finite only).
  const gx: number[] = [];
  const gy: number[] = [];
  const gz: number[] = [];
  let groundOffered = 0;
  for (let i = 0; i < points.length; i++) {
    if (isGround[i] !== 1) continue;
    groundOffered++;
    const [h1, h2, v] = axes(points[i], vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    gx.push(h1);
    gy.push(h2);
    gz.push(v);
  }
  const analyzed = gx.length;

  // Resolve the grid.
  let grid = params.grid;
  if (!grid) {
    if (analyzed === 0) {
      warnings.push('no ground returns — empty DTM');
      return emptyRaster(params.cellSizeM ?? 1, warnings);
    }
    const cellSizeM = finitePositive(params.cellSizeM ?? 1, 1, 'cellSizeM', warnings);
    let minH1 = Infinity;
    let minH2 = Infinity;
    let maxH1 = -Infinity;
    let maxH2 = -Infinity;
    for (let i = 0; i < analyzed; i++) {
      if (gx[i] < minH1) minH1 = gx[i];
      if (gy[i] < minH2) minH2 = gy[i];
      if (gx[i] > maxH1) maxH1 = gx[i];
      if (gy[i] > maxH2) maxH2 = gy[i];
    }
    grid = {
      originH1: minH1,
      originH2: minH2,
      cols: Math.max(1, Math.floor((maxH1 - minH1) / cellSizeM) + 1),
      rows: Math.max(1, Math.floor((maxH2 - minH2) / cellSizeM) + 1),
      cellSizeM,
    };
  }

  const { originH1, originH2, cols, rows, cellSizeM } = grid;
  const nCells = cols * rows;
  const z = new Float32Array(nCells).fill(NaN);
  const counts = new Uint32Array(nCells);
  const accum = new Float64Array(nCells); // sum for mean
  // Per-cell value lists, only allocated for list-needing modes. Sparse: a cell
  // gets its small array only when it first receives a return, so memory tracks
  // the number of *filled* cells, not the full grid.
  const lists: Array<number[] | undefined> | null = needsLists
    ? new Array<number[] | undefined>(nCells)
    : null;

  for (let i = 0; i < analyzed; i++) {
    let col = Math.floor((gx[i] - originH1) / cellSizeM);
    let row = Math.floor((gy[i] - originH2) / cellSizeM);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    const c = row * cols + col;
    if (lists) {
      let list = lists[c];
      if (list === undefined) {
        list = [];
        lists[c] = list;
      }
      list.push(gz[i]);
    } else if (counts[c] === 0) {
      z[c] = gz[i];
      accum[c] = gz[i];
    } else if (aggregation === 'min') {
      if (gz[i] < z[c]) z[c] = gz[i];
    } else {
      accum[c] += gz[i];
    }
    counts[c]++;
  }
  if (aggregation === 'mean') {
    for (let c = 0; c < nCells; c++) {
      if (counts[c] > 0) z[c] = accum[c] / counts[c];
    }
  } else if (lists) {
    // Reduce each filled cell's small list once. Sorting is per-cell (small),
    // never a global O(N log N) sort over all returns.
    for (let c = 0; c < nCells; c++) {
      const list = lists[c];
      if (list === undefined || list.length === 0) continue;
      list.sort((a, b) => a - b);
      if (aggregation === 'median') z[c] = quantileSorted(list, 0.5);
      else if (aggregation === 'percentile') z[c] = quantileSorted(list, percentile);
      else z[c] = robustEstimateSorted(list);
    }
  }

  let filledCellCount = 0;
  for (let c = 0; c < nCells; c++) if (counts[c] > 0) filledCellCount++;

  if (analyzed < groundOffered) {
    warnings.push(`${groundOffered - analyzed} non-finite ground returns skipped`);
  }
  if (filledCellCount < nCells) {
    warnings.push(
      `${nCells - filledCellCount} of ${nCells} cells have no ground data (will need interpolation)`,
    );
  }

  return {
    z,
    counts,
    cols,
    rows,
    cellSizeM,
    originH1,
    originH2,
    coverage: 'full',
    sourcePointCount: groundOffered,
    analyzedPointCount: analyzed,
    filledCellCount,
    warnings,
  };
}

function emptyRaster(cellSizeM: number, warnings: string[]): DemRaster {
  return {
    z: new Float32Array(0),
    counts: new Uint32Array(0),
    cols: 0,
    rows: 0,
    cellSizeM,
    originH1: 0,
    originH2: 0,
    coverage: 'full',
    sourcePointCount: 0,
    analyzedPointCount: 0,
    filledCellCount: 0,
    warnings,
  };
}

function finitePositive(v: number, fallback: number, name: string, warnings: string[]): number {
  if (Number.isFinite(v) && v > 0) return v;
  warnings.push(`${name} invalid (${v}); using ${fallback}`);
  return fallback;
}

/** Clamp a fraction to [0, 1]; non-finite collapses to 0.5 (median). */
function clampUnit(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Quantile of an ASCENDING-sorted, non-empty list at fraction `p` in [0, 1],
 * using linear interpolation between the two bracketing order statistics (the
 * "linear"/type-7 convention, matching NumPy's default `percentile`). `p = 0`
 * returns the minimum, `p = 1` the maximum, `p = 0.5` the median.
 */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Robust cell estimator over an ASCENDING-sorted, non-empty list.
 *
 * Definition: a MAD-clipped trimmed mean centred on the median.
 *   1. m   = median(values)
 *   2. MAD = median(|value − m|)              (median absolute deviation)
 *   3. σ̂  = 1.4826 · MAD                       (MAD → Gaussian-σ estimate)
 *   4. Keep values within m ± 3·σ̂; the result is the MEAN of the kept set.
 *
 * Rationale: the median (breakdown 50 %) sets a resistant centre, MAD gives a
 * resistant scale, and the 3σ̂ gate (the standard outlier-rejection threshold)
 * discards gross blunders — high (vegetation) or low (multipath) — before
 * averaging the inliers, so the estimate is both outlier-resistant and smoother
 * than a bare median when the cell's inliers are clustered.
 *
 * Degenerate cases: with MAD = 0 (e.g. a tie-heavy cell like [10,10,10,50])
 * the inlier band collapses to exactly the median value, so only returns equal
 * to the median survive and the result is the median itself — the outlier is
 * rejected. n = 1 returns that single value.
 */
function robustEstimateSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const m = quantileSorted(sorted, 0.5);
  // MAD: median of absolute deviations from m.
  const dev = new Array<number>(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(sorted[i] - m);
  dev.sort((a, b) => a - b);
  const mad = quantileSorted(dev, 0.5);
  const sigma = 1.4826 * mad;
  // MAD = 0 → no spread among the bulk; keep only values at the median so a
  // tie-heavy cell rejects its outliers and returns the median exactly.
  const band = sigma; // gate is m ± 3σ̂ below; band==0 keeps only |dev| <= 0.
  let sum = 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(sorted[i] - m) <= 3 * band) {
      sum += sorted[i];
      kept++;
    }
  }
  // Safety: if the gate somehow rejects everything (shouldn't, the median is
  // always within the band), fall back to the median.
  return kept > 0 ? sum / kept : m;
}
