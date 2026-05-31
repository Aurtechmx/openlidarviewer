/**
 * densityColors.ts
 *
 * Density heatmap colouring. Per-point colour is derived from the local
 * neighbourhood density (points per unit horizontal area) computed via a
 * voxel-grid bucket pass. Pure, unit-testable, no three.js.
 *
 * Why a heatmap, not a scalar? The Scan Report already exposes a single
 * global density figure (`points / footprintArea`). That's useful for
 * coverage at scan scale, but it hides the failure mode every analyst
 * actually hits — a survey looks dense on average, then turns out to
 * have a sparsely covered corner that drops below the spec. A per-point
 * heatmap surfaces those corners immediately.
 *
 * Algorithm:
 *
 *   1. Hash every point into a 2D voxel grid keyed by (x, y). The grid
 *      cell size defaults to a function of the cloud's spacing so dense
 *      clouds get a finer grid than sparse ones.
 *   2. Count points per cell.
 *   3. Each point's "local density" is its cell's count divided by the
 *      cell's horizontal area, expressed in points / m².
 *   4. Colour each point by mapping that density through a perceptual
 *      ramp (Inferno by default — dark "no coverage" at the bottom,
 *      bright yellow at saturation). The mapping is log-scaled because
 *      density values span orders of magnitude in any real scan.
 *
 * Streaming-aware: callers pass only the resident node's positions, and
 * `densityForChunk` returns just that node's colours. The streaming
 * coloring path repeats the same call per-node.
 */

/** A perceptual hot-cold ramp tuned for density. Black → magenta → orange → yellow. */
const DENSITY_RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
  [0.0, 0, 0, 8],
  [0.2, 60, 12, 95],
  [0.4, 142, 25, 91],
  [0.6, 218, 60, 51],
  [0.8, 252, 145, 0],
  [1.0, 252, 255, 164],
];

/** Sample the density ramp at `t` in [0, 1]. */
function sampleRamp(t: number): [number, number, number] {
  if (t <= 0) return [DENSITY_RAMP[0][1], DENSITY_RAMP[0][2], DENSITY_RAMP[0][3]];
  const last = DENSITY_RAMP[DENSITY_RAMP.length - 1];
  if (t >= 1) return [last[1], last[2], last[3]];
  for (let i = 1; i < DENSITY_RAMP.length; i++) {
    const upper = DENSITY_RAMP[i];
    if (t > upper[0]) continue;
    const lower = DENSITY_RAMP[i - 1];
    const span = upper[0] - lower[0];
    const f = span <= 0 ? 0 : (t - lower[0]) / span;
    return [
      lower[1] + (upper[1] - lower[1]) * f,
      lower[2] + (upper[2] - lower[2]) * f,
      lower[3] + (upper[3] - lower[3]) * f,
    ];
  }
  return [last[1], last[2], last[3]];
}

/** Inputs to the density colour computation. */
export interface DensityInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /**
   * Horizontal voxel cell size in metres. Smaller cells → finer heatmap
   * but more variance per cell. The caller (Viewer / streaming color
   * path) chooses a value based on cloud spacing; ~5× spacing is a
   * reasonable default.
   */
  cellSize: number;
  /**
   * Min density (points / m²) anchoring the cold end of the ramp. Below
   * this → "no coverage" colour. Defaults to 0.
   */
  minDensity?: number;
  /**
   * Max density (points / m²) anchoring the hot end of the ramp. Above
   * this → saturated yellow. Defaults to `auto` — uses the 95th
   * percentile of cell densities so a handful of outlier cells don't
   * squash the visible dynamic range.
   */
  maxDensity?: number | 'auto';
}

/** Result of `densityForChunk`. */
export interface DensityColors {
  /** Interleaved RGB (3 bytes per point). */
  colors: Uint8Array;
  /** Mean density across hit cells (points / m²). */
  meanDensity: number;
  /** Maximum cell density seen (points / m²). */
  maxObservedDensity: number;
}

/**
 * Compute density-based colours for a single chunk of points.
 *
 * Returns a flat interleaved RGB buffer plus a small stats record useful
 * for an inspector overlay (mean / max).
 */
export function densityForChunk(input: DensityInput): DensityColors {
  const positions = input.positions;
  const cellSize = Math.max(1e-6, input.cellSize);
  const n = positions.length / 3;
  const colors = new Uint8Array(n * 3);

  if (n === 0) {
    return { colors, meanDensity: 0, maxObservedDensity: 0 };
  }

  // Hash into a 2D voxel map: cellKey = `${ix}|${iy}`. Sparse maps are
  // cheap in JS; a typed grid would need bounds, which we don't know
  // up-front for a streamed chunk. Counting is O(N).
  const counts = new Map<string, number>();
  const cellOfPoint = new Int32Array(n);
  const tmpKeyA = new Float64Array(2); // [ix, iy] working scratch
  const keys: string[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    tmpKeyA[0] = ix;
    tmpKeyA[1] = iy;
    const k = ix + '|' + iy;
    keys[i] = k;
    cellOfPoint[i] = i; // unused, kept for symmetry
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const cellArea = cellSize * cellSize;
  let sum = 0;
  let maxObs = 0;
  const densities = new Float32Array(counts.size);
  let di = 0;
  for (const c of counts.values()) {
    const d = c / cellArea;
    densities[di++] = d;
    sum += d;
    if (d > maxObs) maxObs = d;
  }
  const meanDensity = densities.length > 0 ? sum / densities.length : 0;

  // Saturation anchor — caller override or 95th percentile.
  let hot: number;
  if (typeof input.maxDensity === 'number' && Number.isFinite(input.maxDensity)) {
    hot = Math.max(1e-9, input.maxDensity);
  } else if (densities.length === 0) {
    hot = 1;
  } else {
    // Sort the Float32Array in place — cheaper than `Array.from().sort()`
    // because it skips the JS allocation and uses the typed comparator.
    densities.sort();
    const p95 = densities[Math.min(densities.length - 1, Math.floor(densities.length * 0.95))];
    hot = Math.max(1e-9, p95);
  }
  const cold = Math.max(0, input.minDensity ?? 0);

  // Log-scaled mapping so an order-of-magnitude variation reads as a smooth
  // gradient rather than a single hot blob. log1p keeps zero inputs at 0.
  // Guard against `cold > hot` (caller passed minDensity above the saturation
  // anchor), which would otherwise produce NaN colours via log1p(negative).
  const logHot = Math.log1p(Math.max(0, hot - cold));

  for (let i = 0; i < n; i++) {
    const cellD = (counts.get(keys[i]) ?? 0) / cellArea;
    const t = logHot > 0 ? Math.log1p(Math.max(0, cellD - cold)) / logHot : 0;
    const rgb = sampleRamp(t);
    colors[i * 3] = rgb[0];
    colors[i * 3 + 1] = rgb[1];
    colors[i * 3 + 2] = rgb[2];
  }

  return { colors, meanDensity, maxObservedDensity: maxObs };
}

/**
 * Pick a default voxel cell size for a cloud. Larger cells → coarser
 * heatmap but more stable readings. ~5 × the cloud's average spacing is
 * a reasonable starting point; the caller can override per-mode.
 */
export function defaultCellSizeForSpacing(spacing: number): number {
  if (!Number.isFinite(spacing) || spacing <= 0) return 1;
  return Math.max(0.05, spacing * 5);
}
