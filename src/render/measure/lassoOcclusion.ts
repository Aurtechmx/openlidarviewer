/**
 * lassoOcclusion.ts — which points inside a lasso the camera can actually see.
 *
 * `selectByLasso` accepts every point whose projection falls inside the drawn
 * polygon, at any depth along the camera ray. That is a deliberate volumetric
 * pick and it is the right answer for a stockpile seen against open ground. It
 * is the wrong answer when something solid stands in the way: lassoing a
 * building also takes the ground under it and the far wall behind it, because
 * nothing in the selection ever asked whether a point was hidden.
 *
 * This module answers that one question, and only that one. It takes projected
 * screen coordinates and a per-point depth as plain typed arrays — no camera,
 * no three.js, no DOM — and returns a keep mask. The decision is a screen-space
 * depth buffer: bucket the candidates into cells, keep the nearest depth per
 * cell, and accept a point when it sits within a tolerance of its own cell's
 * nearest depth.
 *
 * The whole design is the two scale parameters, and neither is a magic number.
 *
 * CELL SIZE. A cell has to hold enough points that its minimum depth describes
 * the nearest SURFACE rather than one lucky return. The candidate set states
 * its own projected spacing: `sqrt(bounding-box area / point count)` is the
 * mean distance between neighbouring projections, in pixels, for this cloud at
 * this zoom. A cell three spacings wide holds about nine points, which is the
 * smallest square neighbourhood whose minimum is a stable estimate, and under a
 * Poisson placement leaves only e^-9 (about one in ten thousand) of cells
 * empty. A fixed pixel count cannot do this: the same cloud at twice the zoom
 * would put four times as many points in a cell, and a sparse ALS strip and a
 * dense drone scan would disagree by two orders of magnitude.
 *
 * DEPTH TOLERANCE. The tolerance must cover everything a SINGLE surface can put
 * behind a cell's nearest return, or a steeply-viewed road gets carved into
 * stripes. Two things do that, and the data states both.
 *
 * The surface TILTS, so its far edge within a cell is legitimately deeper than
 * its near edge. Estimating that has to survive the case the whole module
 * exists for: two surfaces present across the WHOLE lasso. Within-cell depth
 * spread cannot be used — with a building over ground, every cell's spread is
 * the building's depth, which is exactly the number that must not become the
 * tolerance. The difference in MINIMUM depth between ADJACENT cells does
 * survive it: both minima come from the nearest surface, so the far surface
 * never enters the estimate. On one continuous surface that same difference is
 * the depth step the surface makes per cell, which is the quantity wanted. Read
 * at the 90th percentile rather than the mean, because a lasso that clips a
 * real edge has genuine occlusion jumps in that population and they must not
 * set the scale.
 *
 * The surface also SCATTERS: returns sit either side of it by the sensor's
 * range noise, so a cell's minimum is not the surface, it is the low tail of
 * the surface, and the tilt term does not see that — with nine samples the
 * minimum is biased low by about 1.5 standard deviations and cell-to-cell
 * jitter of a biased minimum is much smaller than the scatter a single point
 * can have. The third-smallest depth in a cell is near the surface's 25th
 * percentile, so `third smallest - smallest` is a scatter estimate that reads
 * only the near surface as long as it holds a quarter of the cell, which is the
 * condition for it to be an occluder at all. Taken as a median over cells so a
 * cell that straddles an edge cannot set it.
 *
 * So: tolerance = 4 × (tilt step + scatter step). The factor is headroom for
 * the fact that a point can sit a full cell-step from its own cell's minimum
 * while both terms measure a quarter- to one-cell quantity.
 *
 * WHAT THIS COSTS. Both terms are multiples of a per-cell quantity, so the
 * tolerance scales with point spacing and with viewing angle, and an object
 * shallower than roughly a dozen point spacings will not be separated from what
 * is behind it. An occluder thinner than a quarter of a cell's returns is also
 * not seen as one. On a sparse cloud viewed along a steep surface those are
 * real limits, not tuning failures, and the honest response is to say which
 * basis produced a number rather than to claim a separation the geometry does
 * not support.
 *
 * The rejection never runs on a candidate set too small or too structureless to
 * estimate from. It reports `applied: false` with a reason instead of guessing,
 * because a guessed tolerance silently deletes part of a real surface and the
 * volume that comes out still looks plausible.
 */

/**
 * The projected candidate set: one entry per point that already passed the
 * polygon test, in selection order.
 *
 * `depth` is distance along the camera's view axis in the cloud's own linear
 * units, increasing away from the camera. View-axis distance rather than a
 * normalised device depth because the tolerance is a length and has to stay
 * comparable across the frustum, which a perspective NDC depth is not.
 * Non-finite depths are carried through as visible: a point whose depth could
 * not be resolved is not evidence that anything is hidden.
 */
export interface LassoDepthField {
  readonly screenX: Float64Array;
  readonly screenY: Float64Array;
  readonly depth: Float64Array;
  /** Entries in use. Bounds the walk, so an over-allocated buffer cannot leak. */
  readonly count: number;
}

/** Why a rejection did or did not run. */
export type OcclusionOutcome =
  | 'applied'
  | 'too-few-points'
  | 'degenerate-extent'
  | 'too-few-adjacent-cells';

/** The keep decision, with the scales it was taken at. */
export interface OcclusionRejection {
  /** 1 = visible, 0 = hidden behind nearer points. Length is `count`. */
  readonly keep: Uint8Array;
  readonly keptCount: number;
  /** False when nothing was rejected because nothing could be estimated. */
  readonly applied: boolean;
  readonly outcome: OcclusionOutcome;
  /** Depth-buffer cell size in screen pixels. 0 when not applied. */
  readonly cellSizePx: number;
  /** Accepted depth spread behind a cell's nearest point, cloud units. 0 when not applied. */
  readonly depthTolerance: number;
}

/**
 * Cell width in mean projected point spacings. Three spacings is about nine
 * points per cell. See the header for why nine and not one or a hundred.
 */
const CELL_SPACINGS = 3;

/**
 * Quantile of the adjacent-cell depth step taken as the per-cell tilt term, the
 * quantile of the per-cell scatter term, and the headroom multiplier applied to
 * their sum. See the header.
 */
const TILT_QUANTILE = 0.9;
const SCATTER_QUANTILE = 0.5;
const TOLERANCE_FACTOR = 4;

/**
 * Fewest candidates worth estimating from. Below this the grid holds a handful
 * of cells, the adjacent-step population is too small for a 90th percentile to
 * mean anything, and a wrong tolerance would carve a surface that is fine.
 */
const MIN_CANDIDATES = 32;

/** Fewest adjacent occupied cell pairs the step estimate needs. */
const MIN_ADJACENT_PAIRS = 8;

/**
 * Decide which candidates the camera can see.
 *
 * One pass for the bounds, one to fill the depth buffer, one over the cells for
 * the step population, one to accept: O(N + C) with C ≈ N / 9 cells, plus an
 * O(C log C) sort of the step population. Allocation is four typed arrays sized
 * by N or C and nothing per point.
 */
export function rejectOccluded(field: LassoDepthField): OcclusionRejection {
  const n = Math.max(0, Math.min(field.count, field.depth.length));
  const keep = new Uint8Array(n).fill(1);
  if (n < MIN_CANDIDATES) {
    return { keep, keptCount: n, applied: false, outcome: 'too-few-points', cellSizePx: 0, depthTolerance: 0 };
  }

  const { screenX, screenY, depth } = field;

  // Bounds over the points that can take part. A point with a non-finite
  // screen or depth value is left visible and kept out of the buffer.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let usable = 0;
  for (let i = 0; i < n; i++) {
    const x = screenX[i];
    const y = screenY[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(depth[i])) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    usable++;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (usable < MIN_CANDIDATES || !(width > 0) || !(height > 0)) {
    return { keep, keptCount: n, applied: false, outcome: 'degenerate-extent', cellSizePx: 0, depthTolerance: 0 };
  }

  // Mean projected spacing, then the cell built from it.
  const spacing = Math.sqrt((width * height) / usable);
  const cell = spacing * CELL_SPACINGS;
  if (!(cell > 0)) {
    return { keep, keptCount: n, applied: false, outcome: 'degenerate-extent', cellSizePx: 0, depthTolerance: 0 };
  }
  const cols = Math.floor(width / cell) + 1;
  const rows = Math.floor(height / cell) + 1;

  // The three nearest depths per cell, in one pass. The smallest is the depth
  // buffer; the third is the scatter probe. Infinity marks "no such return".
  const cellCount = cols * rows;
  const cellMin = new Float64Array(cellCount).fill(Infinity);
  const cellMin2 = new Float64Array(cellCount).fill(Infinity);
  const cellMin3 = new Float64Array(cellCount).fill(Infinity);
  const cellOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const x = screenX[i];
    const y = screenY[i];
    const d = depth[i];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(d)) continue;
    const cx = Math.floor((x - minX) / cell);
    const cy = Math.floor((y - minY) / cell);
    const c = cy * cols + cx;
    cellOf[i] = c;
    if (d < cellMin[c]) {
      cellMin3[c] = cellMin2[c];
      cellMin2[c] = cellMin[c];
      cellMin[c] = d;
    } else if (d < cellMin2[c]) {
      cellMin3[c] = cellMin2[c];
      cellMin2[c] = d;
    } else if (d < cellMin3[c]) {
      cellMin3[c] = d;
    }
  }

  // Depth step between adjacent occupied cells. Right and down neighbours only:
  // every adjacent pair is then visited exactly once.
  const steps = new Float64Array(cellCount * 2);
  const scatters = new Float64Array(cellCount);
  let pairs = 0;
  let scatterCells = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = cy * cols + cx;
      const here = cellMin[c];
      if (here === Infinity) continue;
      if (cellMin3[c] !== Infinity) scatters[scatterCells++] = cellMin3[c] - here;
      if (cx + 1 < cols) {
        const right = cellMin[c + 1];
        if (right !== Infinity) steps[pairs++] = Math.abs(right - here);
      }
      if (cy + 1 < rows) {
        const down = cellMin[c + cols];
        if (down !== Infinity) steps[pairs++] = Math.abs(down - here);
      }
    }
  }
  if (pairs < MIN_ADJACENT_PAIRS) {
    return {
      keep,
      keptCount: n,
      applied: false,
      outcome: 'too-few-adjacent-cells',
      cellSizePx: cell,
      depthTolerance: 0,
    };
  }

  const tilt = quantileInPlace(steps.subarray(0, pairs), TILT_QUANTILE);
  const scatter = quantileInPlace(scatters.subarray(0, scatterCells), SCATTER_QUANTILE);
  const tolerance = TOLERANCE_FACTOR * (tilt + scatter);

  let kept = 0;
  for (let i = 0; i < n; i++) {
    const c = cellOf[i];
    if (c < 0) {
      kept++;
      continue;
    }
    if (depth[i] <= cellMin[c] + tolerance) {
      kept++;
    } else {
      keep[i] = 0;
    }
  }

  return { keep, keptCount: kept, applied: true, outcome: 'applied', cellSizePx: cell, depthTolerance: tolerance };
}

/**
 * Quantile of a Float64Array, sorting the array itself. `p` is a fraction in
 * `[0, 1]`, interpolated between the two nearest ranks, matching
 * `lassoVolume.percentile`'s convention so the two never disagree by a rank.
 * The caller owns the buffer and does not need it ordered afterwards.
 */
function quantileInPlace(values: Float64Array, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  values.sort();
  const idx = Math.max(0, Math.min(1, p)) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return values[lo];
  return values[lo] * (hi - idx) + values[hi] * (idx - lo);
}

/**
 * Which selection basis produced a lasso figure.
 *
 * `occluded-excluded` took only what the camera can see. `through-surfaces`
 * took every point along the ray, the basis every lasso volume was measured on
 * before this existed.
 */
export type LassoSelectionBasis = 'occluded-excluded' | 'through-surfaces';

/**
 * The clause a panel, toast or report can show for a selection basis.
 *
 * A run that asked for occlusion and could not estimate a tolerance says so
 * rather than implying either answer: the figure is a through-surfaces figure
 * whatever was requested, and reading it as a visible-surface one would be
 * wrong.
 */
export function describeLassoSelectionBasis(
  basis: LassoSelectionBasis,
  outcome?: OcclusionOutcome,
): string {
  if (basis === 'through-surfaces') return 'all depths along the ray';
  if (outcome !== undefined && outcome !== 'applied') {
    return 'visible surfaces requested, all depths taken (too little structure to separate them)';
  }
  return 'visible surfaces only';
}
