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

/** Per-cell aggregation strategy for ground returns. */
export type DtmAggregation = 'mean' | 'min';

/** Options for {@link rasterizeDtm}. */
export interface RasterizeDtmParams {
  /** Cell size, source linear units. Ignored when `grid` is provided. */
  readonly cellSizeM?: number;
  /** Align to this grid instead of deriving one from the points. */
  readonly grid?: GridSpec;
  /** How to combine multiple ground returns in one cell. Default `mean`. */
  readonly aggregation?: DtmAggregation;
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

  for (let i = 0; i < analyzed; i++) {
    let col = Math.floor((gx[i] - originH1) / cellSizeM);
    let row = Math.floor((gy[i] - originH2) / cellSizeM);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    const c = row * cols + col;
    if (counts[c] === 0) {
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
