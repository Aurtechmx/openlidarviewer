/**
 * dtmScatter.ts
 *
 * GPU compute phase 2 (tech evaluation 2026-06 §2): point→cell binning for
 * the DTM, the part that IS atomics-tractable on the GPU. Only the
 * INTEGER-STABLE reductions move — per-cell `min` elevation and per-cell
 * `count` (which doubles as the density layer). `mean` (a float sum that
 * reassociates), `median`, `percentile`, and `robust` (each needs every
 * value in a cell) stay on the CPU `rasterizeDtm`; the engine wires the GPU
 * in ONLY for `min`/`count` (see TerrainRasterEngine.gridFromPoints).
 *
 * WHY only min/count get the GPU, and why the equivalence can be EXACT, not
 * tolerance-bounded:
 *
 *   - COUNT is integer addition — order-independent, so a parallel
 *     `atomicAdd` over the cells is bit-for-bit the same total as the CPU's
 *     sequential `counts[c]++`. No tolerance needed.
 *   - MIN of a set of f32 values is also order-independent: min(min(a,b),c)
 *     == min over the set regardless of scatter order. The CPU keeps the
 *     elevation as f32 and takes the smallest; the GPU takes the same
 *     smallest f32. The only obstacle is that WebGPU has no `atomic<f32>`,
 *     so we min in u32 space through an ORDER-PRESERVING bit mapping
 *     ({@link floatBitsToOrderedU32}): the u32 ordering matches the f32
 *     numeric ordering, so `atomicMin` on the keys selects exactly the
 *     smallest f32, which decodes back bit-identically. Hence the probe can
 *     assert EXACT equality for both `z` (min) and `counts`.
 *
 * The f32 numeric ↔ ordered-u32 mapping (the standard radix-sort key):
 *   - non-negative floats: flip only the sign bit → 0x8000_0000 | bits;
 *   - negative floats: flip ALL bits → ~bits.
 * This makes u32 comparison agree with IEEE-754 f32 comparison for every
 * finite value (−∞ … +∞), so `atomicMin` over the keys == min over the
 * floats. NaN never enters: the caller drops non-finite returns first (the
 * same `Number.isFinite` filter the CPU rasteriser uses).
 *
 * The CPU REFERENCE ({@link scatterMinCountReference}) reproduces the CPU
 * rasteriser's cell binning EXACTLY — same `Math.floor((coord − origin) /
 * cell)` indexing, same edge clamp into [0, cols)×[0, rows), same
 * empty-cell-stays-NaN convention — so the Node harness and the per-session
 * probe compare the GPU scatter against the very arithmetic
 * `rasterizeDtm('min')` performs. It is the ground truth the GPU must match.
 *
 * Pure data, loadable in Node and workers. Deterministic.
 */

/** Resolved grid the scatter bins into (origin + extent + cell size). */
export interface ScatterGrid {
  readonly originH1: number;
  readonly originH2: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

/** A flat (h1, h2, v) point batch — the finite ground returns to scatter. */
export interface ScatterPoints {
  /** Horizontal-1 (east) coordinates, metres-equivalent (source units). */
  readonly h1: Float64Array | Float32Array;
  /** Horizontal-2 (north) coordinates. */
  readonly h2: Float64Array | Float32Array;
  /** Vertical (elevation) values — the quantity reduced by `min`. */
  readonly v: Float64Array | Float32Array;
  /** Number of points (h1/h2/v are at least this long). */
  readonly count: number;
}

/** Result of a min/count scatter: one elevation + one count per grid cell. */
export interface ScatterMinCount {
  /** Per-cell minimum elevation (f32); NaN where the cell got no return. */
  readonly z: Float32Array;
  /** Per-cell return count. `counts[i]` doubles as the density layer. */
  readonly counts: Uint32Array;
}

/**
 * The u32 sentinel for "no return yet" in the atomic-min key buffer:
 * 0xFFFFFFFF is the ordered key of +∞ (the largest finite key is below it),
 * so `atomicMin` is correctly displaced by the first real value, and a cell
 * still holding the sentinel after the scatter had zero returns → NaN.
 */
export const SCATTER_MIN_SENTINEL = 0xffffffff >>> 0;

/**
 * Map an f32's bit pattern to an order-preserving u32 key (the radix-sort
 * trick): for non-negative floats flip the sign bit; for negative floats
 * flip every bit. u32 comparison of the keys then matches f32 numeric
 * comparison, so `atomicMin` over keys selects the smallest float. Input is
 * the raw 32-bit pattern (see {@link f32ToOrderedKey} for the float entry).
 */
export function floatBitsToOrderedU32(bits: number): number {
  // Sign bit set → negative float → flip all 32 bits; else flip only sign.
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits | 0x80000000) >>> 0);
}

/** Inverse of {@link floatBitsToOrderedU32}: ordered key → raw f32 bits. */
export function orderedU32ToFloatBits(key: number): number {
  // The top bit of the KEY tells us the original sign: non-negative floats
  // had their sign bit forced to 1 (key top bit 1), negatives had it cleared.
  return (key & 0x80000000) !== 0 ? ((key & 0x7fffffff) >>> 0) : (~key >>> 0);
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** Ordered-u32 key for a float value (rounded to f32 first, as on the GPU). */
export function f32ToOrderedKey(value: number): number {
  _f32[0] = value;
  return floatBitsToOrderedU32(_u32[0]);
}

/** Decode an ordered-u32 key back to the f32 value it represents. */
export function orderedKeyToF32(key: number): number {
  _u32[0] = orderedU32ToFloatBits(key);
  return _f32[0];
}

/**
 * Bin (h1, h2) into a cell index with the SAME arithmetic as
 * `rasterizeDtm`: floor-divide by the cell size relative to the origin, then
 * clamp into [0, cols)×[0, rows) (returns outside the grid stick to the
 * nearest edge cell, exactly as the CPU does).
 */
export function cellIndex(
  h1: number,
  h2: number,
  grid: ScatterGrid,
): number {
  const { originH1, originH2, cols, rows, cellSizeM } = grid;
  let col = Math.floor((h1 - originH1) / cellSizeM);
  let row = Math.floor((h2 - originH2) / cellSizeM);
  if (col < 0) col = 0;
  else if (col >= cols) col = cols - 1;
  if (row < 0) row = 0;
  else if (row >= rows) row = rows - 1;
  return row * cols + col;
}

/**
 * CPU REFERENCE for the min/count scatter — the exact arithmetic
 * `rasterizeDtm('min')` performs over the same grid: smallest f32 elevation
 * per cell (NaN where empty) plus the return count. This is the ground truth
 * the GPU kernel must match bit-for-bit (min and count are both
 * order-independent), and it is also the always-available fallback.
 *
 * Inputs are assumed already finite-filtered (the caller mirrors the CPU's
 * `Number.isFinite` gate before calling). Elevations are stored through an
 * f32 round-trip so the reference min is taken in the SAME precision the GPU
 * key uses — a value that is only the minimum after f32 rounding must agree.
 *
 * EXACT-EQUIVALENCE NOTE. `rasterizeDtm('min')` compares the raw f64 return
 * against the f32-stored running min, then stores the winner as f32. Source
 * point coordinates here come from f32 position buffers, so every elevation
 * is ALREADY exactly f32-representable; the f64-vs-f32 comparison and this
 * pure-f32 comparison then pick the identical winner, and this reference is
 * byte-identical to `rasterizeDtm('min').z`/`.counts`. (The engine probe
 * asserts that identity on synthetic f32 data before trusting the GPU.)
 */
export function scatterMinCountReference(
  points: ScatterPoints,
  grid: ScatterGrid,
): ScatterMinCount {
  const nCells = grid.cols * grid.rows;
  const z = new Float32Array(nCells).fill(NaN);
  const counts = new Uint32Array(nCells);
  const f32 = new Float32Array(1);
  const { h1, h2, v, count } = points;
  for (let i = 0; i < count; i++) {
    const c = cellIndex(h1[i], h2[i], grid);
    f32[0] = v[i]; // store-as-f32, exactly like the DemRaster z buffer
    const zv = f32[0];
    if (counts[c] === 0 || zv < z[c]) z[c] = zv;
    counts[c]++;
  }
  return { z, counts };
}
