/**
 * occupancyGrid.ts
 *
 * Stage 2 of the floor-plan extraction pipeline: rasterise the 2-D point
 * slice into a DENSITY-THRESHOLDED occupancy mask, then close small scan
 * gaps morphologically.
 *
 * WHY density-thresholded (not mere presence): a vertical wall projects its
 * whole band of returns into one column of cells, so wall cells carry MANY
 * points while stray clutter at wall height (a lamp top, a door leaf edge)
 * leaves one or two. Thresholding at a fraction of the mean occupied-cell
 * count keeps the walls and drops the speckle, and because the threshold is
 * relative it survives sparse scans (half the points ⇒ half the mean ⇒ the
 * walls still clear it).
 *
 * WHY the closing radius is derived from `keepOpenM`: morphological closing
 * (dilate then erode) bridges gaps up to twice its radius. Scan dropouts on
 * a wall are centimetres wide and must be bridged; doorways (~0.6 m and up)
 * are REAL openings and must never be sealed. The radius is therefore capped
 * so the largest bridgeable gap is at most `keepOpenM / 3` — a doorway
 * cannot be closed even diagonally, by construction.
 *
 * Pure data, deterministic, O(points + cells). No DOM.
 */

export interface OccupancyGridParams {
  /** Smallest allowed cell, metres. Default 0.02 (2 cm). */
  readonly cellMinM?: number;
  /** Largest allowed (preferred) cell, metres. Default 0.05 (5 cm). */
  readonly cellMaxM?: number;
  /**
   * Hard ceiling the cell may GROW to when the slice is too sparse to support
   * `cellMaxM` cells (see the sparse-slice adaptation below). Default 0.3 —
   * still well under a doorway, so openings survive at the coarsest cell.
   */
  readonly cellHardMaxM?: number;
  /** Cell ≈ this × the estimated point spacing. Default 2.5. */
  readonly spacingFactor?: number;
  /** Hard cap on grid dimensions (memory guard). Default 1024. */
  readonly maxCellsPerAxis?: number;
  /** Absolute floor for the wall threshold (points per cell). Default 2. */
  readonly minCellCount?: number;
  /** Wall threshold as a fraction of the mean occupied-cell count. Default 0.3. */
  readonly thresholdFrac?: number;
}

export interface OccupancyGrid {
  /** Binary mask, row-major (rows × cols); 1 = occupied / wall. */
  readonly mask: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** Cell size along x / y, metres (fitted to the bbox, so nearly square). */
  readonly cellX: number;
  readonly cellY: number;
  /** World coordinate of the grid's (0,0) corner, metres. */
  readonly originX: number;
  readonly originY: number;
  /** The points-per-cell threshold actually applied. */
  readonly threshold: number;
}

/**
 * Rasterise slice points into a thresholded occupancy mask. Cells are FITTED
 * to the bounding box (cols = round(extent / target)) so the grid area equals
 * the data extent exactly — the floor-area figure derived from cell counts
 * then has no half-cell rim bias. Returns null when the slice is degenerate
 * (too few points or a collapsed extent) — the caller reports honestly.
 */
export function buildOccupancyMask(
  xs: Float64Array,
  ys: Float64Array,
  count: number,
  params: OccupancyGridParams = {},
): OccupancyGrid | null {
  if (count < 8) return null;
  const cellMin = Math.max(0.001, params.cellMinM ?? 0.02);
  const cellMax = Math.max(cellMin, params.cellMaxM ?? 0.05);
  const cellHardMax = Math.max(cellMax, params.cellHardMaxM ?? 0.3);
  const spacingFactor = Math.max(0.5, params.spacingFactor ?? 2.5);
  const maxCells = Math.max(16, Math.floor(params.maxCellsPerAxis ?? 1024));
  const minCellCount = Math.max(1, Math.floor(params.minCellCount ?? 2));
  const thresholdFrac = Math.min(1, Math.max(0, params.thresholdFrac ?? 0.3));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = xs[i], y = ys[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const ex = maxX - minX;
  const ey = maxY - minY;
  if (!(ex > 1e-6) || !(ey > 1e-6)) return null;

  // Adaptive cell from the (areal) point spacing estimate, clamped to the
  // 2–5 cm architectural range, then re-clamped so the grid stays bounded.
  const spacing = Math.sqrt((ex * ey) / count);
  let target = Math.min(cellMax, Math.max(cellMin, spacingFactor * spacing));
  target = Math.max(target, ex / maxCells, ey / maxCells);

  /** Rasterise at one cell size; report the occupied-cell statistics. */
  const rasterise = (
    cellTarget: number,
  ): {
    counts: Uint32Array;
    cols: number;
    rows: number;
    cellX: number;
    cellY: number;
    occupied: number;
    total: number;
  } | null => {
    const cols = Math.max(1, Math.round(ex / cellTarget));
    const rows = Math.max(1, Math.round(ey / cellTarget));
    const cellX = ex / cols;
    const cellY = ey / rows;
    const counts = new Uint32Array(cols * rows);
    for (let i = 0; i < count; i++) {
      let c = Math.floor((xs[i] - minX) / cellX);
      if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
      let r = Math.floor((ys[i] - minY) / cellY);
      if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
      counts[r * cols + c]++;
    }
    let occupied = 0, total = 0;
    for (let i = 0; i < counts.length; i++) {
      if (counts[i] > 0) { occupied++; total += counts[i]; }
    }
    if (occupied === 0) return null;
    return { counts, cols, rows, cellX, cellY, occupied, total };
  };

  // ── Sparse-slice adaptation ──
  // The 2–5 cm architectural target assumes a slice dense enough that a wall
  // cell collects several returns. A SPARSE slice (a strided gather over a
  // large multi-room scan) leaves the mean occupied cell with ~1 return, so
  // the density threshold (≥ minCellCount) starves the mask into speckle and
  // the plan fragments. When the mean occupied-cell count cannot support the
  // threshold with headroom (2 × minCellCount), grow the cell — areal scaling,
  // so doubling the count per cell needs √2 the size — and re-rasterise, up to
  // a hard ceiling that still keeps doorways (≥ 0.6 m) wider than any cell.
  // A dense slice never enters the loop and keeps its 2–5 cm cells.
  let grid = rasterise(target);
  if (grid == null) return null;
  const NEEDED_MEAN = 2 * minCellCount;
  for (let attempt = 0; attempt < 4; attempt++) {
    const mean = grid.total / grid.occupied;
    if (mean >= NEEDED_MEAN || target >= cellHardMax) break;
    const growth = Math.sqrt(NEEDED_MEAN / mean);
    target = Math.min(cellHardMax, target * Math.max(1.25, growth));
    const regrown = rasterise(target);
    if (regrown == null) break;
    grid = regrown;
  }

  const { counts, cols, rows, cellX, cellY, occupied, total } = grid;

  // Relative threshold: fraction of the mean OCCUPIED cell count, floored at
  // minCellCount so a single stray return can never paint a wall cell.
  const meanOccupied = total / occupied;
  const threshold = Math.max(minCellCount, Math.round(thresholdFrac * meanOccupied));

  const mask = new Uint8Array(cols * rows);
  for (let i = 0; i < counts.length; i++) mask[i] = counts[i] >= threshold ? 1 : 0;

  return { mask, cols, rows, cellX, cellY, originX: minX, originY: minY, threshold };
}

/** Occupied area of the mask in m² (cells × exact cell area). */
export function maskAreaM2(grid: OccupancyGrid): number {
  let occ = 0;
  for (let i = 0; i < grid.mask.length; i++) if (grid.mask[i]) occ++;
  return occ * grid.cellX * grid.cellY;
}

/**
 * Morphological close (8-neighbour dilate, then erode, `radiusCells` times
 * each) — bridges scan gaps up to ~2×radius cells wide while leaving wider,
 * real openings (doorways) untouched. Returns a NEW grid; the input mask is
 * not mutated.
 */
export function closeMask(grid: OccupancyGrid, radiusCells: number): OccupancyGrid {
  const r = Math.max(0, Math.floor(radiusCells));
  if (r === 0) return grid;
  let mask: Uint8Array = grid.mask.slice();
  for (let i = 0; i < r; i++) mask = dilate(mask, grid.cols, grid.rows);
  for (let i = 0; i < r; i++) mask = erode(mask, grid.cols, grid.rows);
  return { ...grid, mask };
}

/**
 * The closing radius (cells) that bridges scan dropouts but can never seal an
 * opening of `keepOpenM` metres: largest bridged gap = 2 × radius × cell ≤
 * keepOpenM / 3 (margin 3× covers the diagonal worst case and threshold
 * jitter at the jambs). Always at least 1 so hairline gaps are healed.
 */
export function closeRadiusCells(cellM: number, keepOpenM: number): number {
  if (!(cellM > 0)) return 1;
  // The 1e-9 absorbs float noise (0.6 / 0.3 evaluating to 1.999…8) so the
  // radius is the intended integer, not one less.
  return Math.max(1, Math.floor(keepOpenM / (6 * cellM) + 1e-9));
}

/**
 * 8-neighbour binary dilation of a raw mask — exported for the island
 * classifier's near-wall test (regularize.ts). Returns a NEW mask.
 */
export function dilateMask(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  return dilate(mask, cols, rows);
}

/** 8-neighbour binary dilation. */
function dilate(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let hit = 0;
      for (let dr = -1; dr <= 1 && !hit; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          if (mask[rr * cols + cc]) { hit = 1; break; }
        }
      }
      out[r * cols + c] = hit;
    }
  }
  return out;
}

/**
 * 8-neighbour binary erosion. Out-of-bounds counts as FILLED: the grid is
 * fitted to the wall bbox, so walls sit ON the border — eroding against an
 * empty outside would shave one cell off every border wall after each close
 * (closing must be extensive: result ⊇ input, including at the border).
 */
function erode(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let all = 1;
      for (let dr = -1; dr <= 1 && all; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue; // outside = filled
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue; // outside = filled
          if (!mask[rr * cols + cc]) { all = 0; break; }
        }
      }
      out[r * cols + c] = all;
    }
  }
  return out;
}
