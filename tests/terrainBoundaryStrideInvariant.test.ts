/**
 * terrainBoundaryStrideInvariant.test.ts — a sampling gap is not a survey edge.
 *
 * "Measured cells near the data boundary" is meant to say how much of the
 * surface sits at the edge of what was surveyed. It is computed by seeding a
 * distance field at every NON-measured cell and counting measured cells within
 * a threshold of one.
 *
 * On a dense grid those seeds are the survey edge. On a grid thinned by a
 * display stride the seeds are mostly interior holes, so nearly every measured
 * cell is adjacent to one and the metric approaches 1 for a tile whose real
 * boundary has not moved. These tests hold the geometry fixed and vary only the
 * thinning, which is the comparison the metric has to survive.
 */

import { describe, it, expect } from 'vitest';
import { computeCellMetrics } from '../src/terrain/quality/cellMetrics';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const MEASURED = 2;
/** Filled from a nearby measured cell: inside the survey, height inferred. */
const INTERPOLATED = 1;
/** No reachable data: outside what was surveyed. */
const NONE = 0;

/**
 * A square grid whose interior is surveyed. `keep` decides which surveyed cells
 * survive the thinning: every cell for a full decode, every other cell for a
 * strided one. The surveyed REGION is identical in both.
 */
function grid(size: number, keep: (r: number, c: number) => boolean): DtmGrid {
  const n = size * size;
  const coverage = new Uint8Array(n);
  const counts = new Uint32Array(n);
  const z = new Float32Array(n);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const i = r * size + c;
      const surveyed = r > 0 && c > 0 && r < size - 1 && c < size - 1;
      if (!surveyed) {
        // Outside the survey: no reachable data.
        coverage[i] = NONE;
      } else if (keep(r, c)) {
        coverage[i] = MEASURED;
        counts[i] = 10;
      } else {
        // A gap the thinning left INSIDE the survey. The pipeline fills these
        // from the measured cells around them, so they are interpolated, not
        // absent.
        coverage[i] = INTERPOLATED;
      }
    }
  }
  return {
    z,
    confidence: new Float32Array(n),
    coverage,
    counts,
    interpDistanceCells: new Float32Array(n),
    cols: size,
    rows: size,
    cellSizeM: 1,
  } as unknown as DtmGrid;
}

const ratioOf = (g: DtmGrid): number =>
  computeCellMetrics(g).summary.boundaryMeasuredRatio;

describe('the boundary share over one geometry at two samplings', () => {
  it('reports a minority of cells as boundary on a full decode', () => {
    // A 24x24 tile surveyed inside its border: only the ring of cells beside
    // the unsurveyed border is genuinely at the edge.
    const full = ratioOf(grid(24, () => true));
    expect(full).toBeLessThan(0.5);
  });

  it('does not report nearly every cell as boundary once the same tile is strided', () => {
    const full = ratioOf(grid(24, () => true));
    const strided = ratioOf(grid(24, (r, c) => r % 2 === 0 && c % 2 === 0));

    // The surveyed region is the same in both. A metric describing the survey
    // edge should not move far when only the sampling changes.
    expect(strided).toBeLessThan(full + 0.25);
  });

  it('keeps the boundary share stable across three samplings of one tile', () => {
    const samples = [
      ratioOf(grid(24, () => true)),
      ratioOf(grid(24, (r, c) => (r + c) % 2 === 0)),
      ratioOf(grid(24, (r, c) => r % 3 === 0 && c % 3 === 0)),
    ];
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeLessThan(0.25);
  });
});
