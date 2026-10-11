/**
 * cellMetrics.ts
 *
 * Per-cell ground-confidence metrics derived from a built DtmGrid, without
 * mutating it: point density, local completeness, and distance to the
 * measured-region boundary. These feed the composite terrain quality score
 * and the Analyse panel so thin, sparse, or edge cells read as lower quality
 * honestly rather than being averaged away.
 *
 * Pure data — no DOM, no three.js. Deterministic.
 */

import type { DtmGrid } from '../ground/cellConfidence';

/** Per-cell metric arrays, parallel to the grid (row-major). */
export interface CellMetrics {
  /** Ground returns per square metre in the cell (0 for non-measured cells). */
  readonly pointDensity: Float32Array;
  /** Fraction (0..1) of cells in the neighbourhood that are measured. */
  readonly localCompleteness: Float32Array;
  /**
   * Distance (in cells) from a measured cell to the nearest non-measured cell
   * or the grid edge — small = on the survey boundary, where the surface is
   * least supported. 0 for non-measured cells.
   */
  readonly edgeDistanceCells: Float32Array;
}

/** Scene-level rollup of the per-cell metrics. */
export interface CellMetricsSummary {
  readonly measuredCellCount: number;
  /**
   * Cells the ground surface covers (measured + interpolated, coverage > 0).
   * The area that `meanDensity` divides by.
   */
  readonly footprintCellCount: number;
  /**
   * Ground returns / m² over the ground surface's covered footprint:
   * Σ counts · countScale / (footprint cells × cell area). The footprint is the
   * covered extent of the surface, not the set of cells that happen to hold a
   * sampled point, so the figure does not rise as the analysed sample thins.
   * (Averaging per-cell densities over occupied cells only is the mean of a
   * count conditional on ≥ 1 point, biased high: about λ / (1 − e^(−λ/s)) for
   * true density λ and stride s.)
   */
  readonly meanDensity: number;
  /**
   * Median ground returns / m² over blocks of footprint cells, each block sized
   * to hold about 20 analysed points so empty cells and the stride do not bias
   * it. Equals per-cell median over the footprint when cells are already that
   * dense.
   */
  readonly medianDensity: number;
  /** Mean local completeness (0..1) over measured cells. */
  readonly meanCompleteness: number;
  /**
   * Fraction of measured cells within `edgeThresholdCells` of the data
   * boundary, where the distance is to the nearest cell WITHOUT a measurement
   * or to the grid edge, whichever is closer. On a scattered ground mask most
   * measured cells sit beside a hole, so this runs high while the grid border
   * itself holds few cells. Boundary proximity of MEASURED cells (they have
   * real returns, just the least neighbour support). Not the dtmCellStatus
   * 'edgeRisk' vocabulary, which tallies interpolated cells far from any
   * measurement.
   */
  readonly boundaryMeasuredRatio: number;
}

export interface CellMetricsParams {
  /** Neighbourhood radius (cells) for local completeness. Default 1 (3×3). */
  readonly completenessRadius?: number;
  /** Distance in cells to the nearest unmeasured cell at/below which a measured cell counts as boundary-proximate. Default 2. */
  readonly edgeThresholdCells?: number;
  /**
   * Metres per source horizontal unit, so point densities read as genuine
   * pts/m² for feet-based (or geographic) frames rather than pts/(source unit)².
   * 1 for metre data, ~0.3048 for feet; for a geographic frame the caller passes
   * the metres-per-degree scale. Default 1 (metric projected — unchanged).
   */
  readonly horizontalUnitToMetres?: number;
  /**
   * Scan-points per analysed point (totalPoints / sampledPoints from the
   * gather), ≥ 1. The grid's per-cell `counts` tally only the points that
   * REACHED the analysis after striding; multiplying by the known stride makes
   * the densities — and everything graded from them (USGS QL) — describe the
   * SCAN rather than the subsample. Default 1 (no striding / unknown — the
   * caller should then label density figures "of analysed sample").
   */
  readonly countScale?: number;
}

const MEASURED = 2;

/** Compute per-cell metrics + a scene summary for a DtmGrid. */
/** CellCoverage 0 — no reachable data, which is the edge of the survey. */
const NO_COVERAGE = 0;

export function computeCellMetrics(
  g: DtmGrid,
  params: CellMetricsParams = {},
): { metrics: CellMetrics; summary: CellMetricsSummary } {
  const { cols, rows, cellSizeM } = g;
  const n = cols * rows;
  const radius = Math.max(1, Math.floor(params.completenessRadius ?? 1));
  const edgeThreshold = Math.max(1, params.edgeThresholdCells ?? 2);
  // Cell area in REAL metres² so densities are pts/m². For metre data the scale
  // is 1; for feet (~0.3048) or a geographic frame (metres-per-degree) the
  // caller supplies the scale, otherwise a foot grid would report ~10.8× too few
  // points per "m²" by measuring area in source units².
  const mpu =
    Number.isFinite(params.horizontalUnitToMetres) && (params.horizontalUnitToMetres as number) > 0
      ? (params.horizontalUnitToMetres as number)
      : 1;
  const cellSizeMetres = cellSizeM * mpu;
  const cellArea = cellSizeMetres > 0 ? cellSizeMetres * cellSizeMetres : 1;
  // Stride correction: per-cell counts only saw the analysed subsample, so
  // multiply by scan-points-per-analysed-point (≥ 1, default 1) to report the
  // SCAN's density. Non-finite / sub-1 values fall back to 1 — a scale below 1
  // would fabricate a density lower than what was actually measured.
  const countScale =
    Number.isFinite(params.countScale) && (params.countScale as number) > 1
      ? (params.countScale as number)
      : 1;

  const pointDensity = new Float32Array(n);
  const localCompleteness = new Float32Array(n);
  const edgeDistanceCells = new Float32Array(n);

  // Measured mask.
  const measured = new Uint8Array(n);
  for (let i = 0; i < n; i++) measured[i] = g.coverage[i] === MEASURED ? 1 : 0;

  // Point density per measured cell.
  for (let i = 0; i < n; i++) {
    if (measured[i]) pointDensity[i] = (g.counts[i] * countScale) / cellArea;
  }

  // Local completeness — fraction of the IN-BOUNDS neighbourhood that is
  // measured. Dividing by in-bounds (not the full window) means a data hole
  // lowers completeness while a grid/survey edge does not — the edge is
  // captured separately by `edgeDistanceCells`, so the two don't double-count.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!measured[i]) continue;
      let m = 0;
      let total = 0;
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          total++;
          if (measured[rr * cols + cc]) m++;
        }
      }
      localCompleteness[i] = total > 0 ? m / total : 0;
    }
  }

  // Edge distance — multi-source BFS from every NON-measured cell (and the
  // off-grid border) outward into the measured region. 4-connectivity.
  const dist = new Float32Array(n).fill(Infinity);
  const queue: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (measured[i]) {
        // A measured cell on the grid border touches off-grid (no data).
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
          dist[i] = 1;
          queue.push(i);
        }
      } else if (g.coverage[i] === NO_COVERAGE) {
        // Only a cell with no reachable data marks the edge of the survey. An
        // interpolated cell was filled from the measured cells around it, so it
        // sits INSIDE the surveyed region: seeding from it made every gap the
        // display stride left look like a survey edge, and the share rose with
        // the thinning rather than with the geometry.
        dist[i] = 0;
        queue.push(i);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const d = dist[i] + 1;
    const nb = [
      r > 0 ? i - cols : -1,
      r < rows - 1 ? i + cols : -1,
      c > 0 ? i - 1 : -1,
      c < cols - 1 ? i + 1 : -1,
    ];
    for (const j of nb) {
      if (j < 0) continue;
      // Travel through every cell inside the survey, measured or interpolated,
      // and record a distance for all of them. Propagating through measured
      // cells alone tied the distance to how densely the surface happened to be
      // sampled: on a thinned grid the measured cells are not adjacent, so no
      // distance could travel and cells away from the edge were left unreached.
      // Only measured cells are counted in the share below.
      if (g.coverage[j] !== NO_COVERAGE && d < dist[j]) {
        dist[j] = d;
        queue.push(j);
      }
    }
  }
  for (let i = 0; i < n; i++) edgeDistanceCells[i] = measured[i] ? dist[i] : 0;

  // Summary.
  let compSum = 0;
  let boundaryMeasured = 0;
  let measuredCount = 0;
  let footprintCount = 0;
  let countSum = 0;
  for (let i = 0; i < n; i++) {
    if (g.coverage[i] !== NO_COVERAGE) {
      footprintCount++;
      countSum += g.counts[i];
    }
    if (!measured[i]) continue;
    measuredCount++;
    compSum += localCompleteness[i];
    if (edgeDistanceCells[i] <= edgeThreshold) boundaryMeasured++;
  }
  // Mean density over the covered FOOTPRINT, not over occupied cells: a cell
  // the sample happened to miss still lies under the surface and still has
  // ground area, so it belongs in the denominator.
  const meanDensity =
    footprintCount > 0 ? (countSum * countScale) / (footprintCount * cellArea) : 0;
  const median = blockMedianDensity(g, countSum, footprintCount, countScale, cellArea);

  return {
    metrics: { pointDensity, localCompleteness, edgeDistanceCells },
    summary: {
      measuredCellCount: measuredCount,
      footprintCellCount: footprintCount,
      meanDensity,
      medianDensity: median,
      meanCompleteness: measuredCount ? compSum / measuredCount : 0,
      boundaryMeasuredRatio: measuredCount ? boundaryMeasured / measuredCount : 0,
    },
  };
}

/** Target analysed points per block for the median density. */
const MEDIAN_BLOCK_POINTS = 20;

/**
 * Median density over square blocks of footprint cells. A per-cell median over
 * a thinned sample is 0 (most cells empty) or, over occupied cells only, biased
 * high; blocks sized to hold ~MEDIAN_BLOCK_POINTS analysed points avoid both.
 * Blocks with less than half their cells in the footprint are skipped (edge
 * slivers would read their density off a partial area).
 */
function blockMedianDensity(
  g: DtmGrid,
  countSum: number,
  footprintCount: number,
  countScale: number,
  cellArea: number,
): number {
  if (footprintCount === 0 || countSum <= 0) return 0;
  const { cols, rows } = g;
  const perCell = countSum / footprintCount;
  const side = Math.max(1, Math.ceil(Math.sqrt(MEDIAN_BLOCK_POINTS / perCell)));
  const vals: number[] = [];
  const full = side * side;
  for (let r0 = 0; r0 < rows; r0 += side) {
    for (let c0 = 0; c0 < cols; c0 += side) {
      let cells = 0;
      let cnt = 0;
      const r1 = Math.min(rows, r0 + side);
      const c1 = Math.min(cols, c0 + side);
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const i = r * cols + c;
          if (g.coverage[i] === NO_COVERAGE) continue;
          cells++;
          cnt += g.counts[i];
        }
      }
      if (cells === 0 || cells * 2 < full) continue;
      vals.push((cnt * countScale) / (cells * cellArea));
    }
  }
  if (vals.length === 0) return (countSum * countScale) / (footprintCount * cellArea);
  vals.sort((a, b) => a - b);
  const m = vals.length;
  return m % 2 === 1 ? vals[(m - 1) >> 1] : (vals[m / 2 - 1] + vals[m / 2]) / 2;
}
