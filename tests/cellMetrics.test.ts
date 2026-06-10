/**
 * cellMetrics.test.ts — per-cell density / completeness / edge-distance.
 */

import { describe, it, expect } from 'vitest';
import { computeCellMetrics } from '../src/terrain/quality/cellMetrics';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function grid(opts: {
  cols: number;
  rows: number;
  coverage: number[];
  counts: number[];
  cellSizeM?: number;
}): DtmGrid {
  const n = opts.cols * opts.rows;
  return {
    z: new Float32Array(n),
    confidence: new Float32Array(n),
    coverage: Uint8Array.from(opts.coverage),
    counts: Uint32Array.from(opts.counts),
    interpDistanceCells: new Float32Array(n),
    cols: opts.cols,
    rows: opts.rows,
    cellSizeM: opts.cellSizeM ?? 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32611',
    verticalDatum: null,
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 80,
    warnings: [],
  };
}

describe('computeCellMetrics', () => {
  it('point density = count / cell area; 0 for non-measured', () => {
    const g = grid({
      cols: 3, rows: 3, cellSizeM: 2, // area 4 m²
      coverage: [2, 2, 2, 2, 0, 2, 2, 2, 2],
      counts: [8, 8, 8, 8, 0, 8, 8, 8, 8],
    });
    const { metrics } = computeCellMetrics(g);
    expect(metrics.pointDensity[0]).toBeCloseTo(2, 6); // 8 / 4
    expect(metrics.pointDensity[4]).toBe(0); // non-measured centre
  });

  it('density is pts/m² — a feet cell area is scaled to metres before dividing', () => {
    // 1-unit cells with 1 point each. In metric data that's 1 pt/m². If the
    // source unit is US feet (0.3048 m), the real cell is 0.3048 m on a side =
    // 0.0929 m², so the SAME points are ~10.76 pts/m² — not 1.
    const g = grid({
      cols: 2, rows: 2, cellSizeM: 1,
      coverage: [2, 2, 2, 2],
      counts: [1, 1, 1, 1],
    });
    const metric = computeCellMetrics(g, { horizontalUnitToMetres: 1 }).summary;
    expect(metric.meanDensity).toBeCloseTo(1, 6);

    const feet = computeCellMetrics(g, { horizontalUnitToMetres: 0.3048 }).summary;
    expect(feet.meanDensity).toBeCloseTo(1 / (0.3048 * 0.3048), 4); // ≈ 10.76 pts/m²
    expect(feet.meanDensity).toBeGreaterThan(metric.meanDensity);

    // A missing / non-positive scale falls back to 1 (no silent zero-divide).
    const fallback = computeCellMetrics(g, { horizontalUnitToMetres: 0 }).summary;
    expect(fallback.meanDensity).toBeCloseTo(1, 6);
  });

  it('local completeness is the measured fraction of the neighbourhood', () => {
    // Fully measured 3×3.
    const full = grid({
      cols: 3, rows: 3,
      coverage: [2, 2, 2, 2, 2, 2, 2, 2, 2],
      counts: [4, 4, 4, 4, 4, 4, 4, 4, 4],
    });
    const { metrics, summary } = computeCellMetrics(full);
    expect(metrics.localCompleteness[4]).toBeCloseTo(1, 6); // centre: 9/9 in-bounds
    // A grid-edge corner with all in-bounds neighbours measured is COMPLETE —
    // the edge itself doesn't lower completeness (that's edgeDistance's job).
    expect(metrics.localCompleteness[0]).toBeCloseTo(1, 6); // corner: 4/4 in-bounds
    expect(summary.meanCompleteness).toBeCloseTo(1, 6);

    // One hole lowers the completeness of cells whose neighbourhood it sits in.
    const holed = grid({
      cols: 3, rows: 3,
      coverage: [2, 2, 2, 2, 0, 2, 2, 2, 2],
      counts: [4, 4, 4, 4, 0, 4, 4, 4, 4],
    });
    const { metrics: m2 } = computeCellMetrics(holed);
    expect(m2.localCompleteness[0]).toBeCloseTo(3 / 4, 6); // corner: 3 of 4 in-bounds measured
    expect(m2.localCompleteness[1]).toBeCloseTo(5 / 6, 6); // top-mid: 5 of 6 in-bounds measured
  });

  it('edge distance: boundary cells are 1, the interior centre is deeper', () => {
    const g = grid({
      cols: 3, rows: 3,
      coverage: [2, 2, 2, 2, 2, 2, 2, 2, 2],
      counts: [4, 4, 4, 4, 4, 4, 4, 4, 4],
    });
    const { metrics, summary } = computeCellMetrics(g);
    expect(metrics.edgeDistanceCells[0]).toBe(1); // corner touches the grid edge
    expect(metrics.edgeDistanceCells[4]).toBe(2); // centre is one step inside
    // With threshold 2, every cell in this tiny grid is edge-risk.
    expect(summary.edgeRiskRatio).toBeCloseTo(1, 6);
  });

  it('summary density stats over measured cells only', () => {
    const g = grid({
      cols: 2, rows: 2, cellSizeM: 1,
      coverage: [2, 2, 2, 0],
      counts: [10, 20, 30, 0],
    });
    const { summary } = computeCellMetrics(g);
    expect(summary.measuredCellCount).toBe(3);
    expect(summary.meanDensity).toBeCloseTo(20, 6); // (10+20+30)/3
    expect(summary.medianDensity).toBeCloseTo(20, 6);
  });
});
