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
  /** Mean ground returns / m² over measured cells. */
  readonly meanDensity: number;
  /** Median ground returns / m² over measured cells (robust). */
  readonly medianDensity: number;
  /** Mean local completeness (0..1) over measured cells. */
  readonly meanCompleteness: number;
  /** Fraction of measured cells within `edgeThresholdCells` of the boundary. */
  readonly edgeRiskRatio: number;
}

export interface CellMetricsParams {
  /** Neighbourhood radius (cells) for local completeness. Default 1 (3×3). */
  readonly completenessRadius?: number;
  /** Edge-distance (cells) at/below which a measured cell counts as edge-risk. Default 2. */
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
        // A measured cell on the grid border touches off-grid (non-measured).
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
          dist[i] = 1;
          queue.push(i);
        }
      } else {
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
      if (measured[j] && d < dist[j]) {
        dist[j] = d;
        queue.push(j);
      }
    }
  }
  for (let i = 0; i < n; i++) edgeDistanceCells[i] = measured[i] ? dist[i] : 0;

  // Summary.
  const densities: number[] = [];
  let densSum = 0;
  let compSum = 0;
  let edgeRisk = 0;
  let measuredCount = 0;
  for (let i = 0; i < n; i++) {
    if (!measured[i]) continue;
    measuredCount++;
    densSum += pointDensity[i];
    densities.push(pointDensity[i]);
    compSum += localCompleteness[i];
    if (edgeDistanceCells[i] <= edgeThreshold) edgeRisk++;
  }
  densities.sort((a, b) => a - b);
  const median = densities.length
    ? densities[(densities.length - 1) >> 1]
    : 0;

  return {
    metrics: { pointDensity, localCompleteness, edgeDistanceCells },
    summary: {
      measuredCellCount: measuredCount,
      meanDensity: measuredCount ? densSum / measuredCount : 0,
      medianDensity: median,
      meanCompleteness: measuredCount ? compSum / measuredCount : 0,
      edgeRiskRatio: measuredCount ? edgeRisk / measuredCount : 0,
    },
  };
}
