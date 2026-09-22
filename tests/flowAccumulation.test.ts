/**
 * flowAccumulation.test.ts: counts follow the surface, area follows the units.
 *
 * Accumulation is checked against terrain whose contributing counts can be
 * added up by hand, because an accumulation bug produces a field that still
 * looks like drainage. The conservation property does most of the work: on a
 * surface with one outlet, that outlet must account for every valid cell, and
 * no arrangement of a miscounted graph satisfies that by accident.
 *
 * The area tests exist for a different failure. Square metres are what a
 * reader quotes, so a grid whose horizontal scale is unknown must withhold
 * them rather than multiply by whatever the cell size happened to default to.
 */
import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import {
  catchmentOf,
  contributingAreaM2,
  flowAccumulation,
} from '../src/simulation/flowPulse/flowAccumulation';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function gridOf(
  rows: readonly (readonly (number | null)[])[],
  cellMetresX = 1,
  cellMetresY = 1,
): FlowGrid {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      valid[r * w + c] = 1;
    }
  }
  return { z, valid, cols: w, rows: h, cellMetresX, cellMetresY };
}

describe('a cell accounts for itself and everything above it', () => {
  it('accumulates along a single downhill chain', () => {
    // One row falling east: each cell collects everything west of it.
    const g = gridOf([[4, 3, 2, 1]]);
    const acc = flowAccumulation(g, d8Flow(g));
    expect([...acc.upstreamCells]).toEqual([1, 2, 3, 4]);
    expect(acc.unresolvedCells).toBe(0);
  });

  it('TF-4 converges on the valley axis', () => {
    // A V-shaped valley draining south down the middle column. The axis must
    // carry more than the flanks, which is the whole claim of the figure.
    const valley = gridOf([
      [5, 4, 5],
      [4, 3, 4],
      [3, 2, 3],
      [2, 1, 2],
    ]);
    const acc = flowAccumulation(valley, d8Flow(valley));
    const axisBottom = acc.upstreamCells[3 * 3 + 1];
    const flankBottom = acc.upstreamCells[3 * 3 + 0];
    expect(axisBottom).toBeGreaterThan(flankBottom);
  });

  it('conserves every valid cell at the single outlet', () => {
    // A plane falling east into one column; summed over that column, the
    // outlets must account for all twelve cells exactly once.
    const g = gridOf([
      [3, 2, 1, 0],
      [3, 2, 1, 0],
      [3, 2, 1, 0],
    ]);
    const acc = flowAccumulation(g, d8Flow(g));
    let atOutlets = 0;
    for (let r = 0; r < 3; r++) atOutlets += acc.upstreamCells[r * 4 + 3];
    expect(atOutlets).toBe(12);
  });

  it('gives a NoData cell nothing, and never counts it upstream', () => {
    const g = gridOf([[4, null, 2, 1]]);
    const acc = flowAccumulation(g, d8Flow(g));
    expect(acc.upstreamCells[1]).toBe(0);
    // The barrier isolates the western cell, so the eastern chain carries
    // only its own two cells.
    expect(acc.upstreamCells[3]).toBe(2);
  });
});

describe('a pit collects its bowl', () => {
  it('counts every cell of the bowl at the sink', () => {
    const bowl = gridOf([
      [5, 5, 5, 5, 5],
      [5, 3, 2, 3, 5],
      [5, 2, 0, 2, 5],
      [5, 3, 2, 3, 5],
      [5, 5, 5, 5, 5],
    ]);
    const d8 = d8Flow(bowl);
    const acc = flowAccumulation(bowl, d8);
    const centre = 2 * 5 + 2;
    // Every cell of the bowl drains to the pit, the outer ring included: a
    // ring cell sits at 5 with an inner neighbour at 2 or 3, so it has a
    // descent to take and never reaches the outlet branch. A closed bowl
    // therefore accounts for the whole grid at its sink.
    expect(acc.upstreamCells[centre]).toBe(25);
    expect([...catchmentOf(bowl, d8, centre)].filter((v) => v === 1).length).toBe(25);
    expect(d8.outletCount).toBe(0);
  });
});

describe('contributing area is withheld when the scale is not known', () => {
  const g = gridOf([[4, 3, 2, 1]], 2, 3); // 6 m² per cell

  it('reports square metres from the per-axis cell size when resolved', () => {
    const acc = flowAccumulation(g, d8Flow(g));
    const area = contributingAreaM2(acc, g, true);
    expect(area).not.toBeNull();
    // The fourth cell drains all four: 4 × 2 m × 3 m.
    expect((area as Float64Array)[3]).toBeCloseTo(24, 10);
  });

  it('returns null rather than a number when it is not', () => {
    const acc = flowAccumulation(g, d8Flow(g));
    expect(contributingAreaM2(acc, g, false)).toBeNull();
  });

  it('still reports cell counts when area is withheld, so the run is not lost', () => {
    const acc = flowAccumulation(g, d8Flow(g));
    expect(contributingAreaM2(acc, g, false)).toBeNull();
    expect([...acc.upstreamCells]).toEqual([1, 2, 3, 4]);
  });
});

describe('a cycle is survived rather than hung', () => {
  it('reports the unresolved cells instead of looping forever', () => {
    // A hand-built pair that receive from each other. D8 cannot produce this
    // from an elevation surface, but a conditioned or imported graph can.
    const g = gridOf([[1, 1]]);
    const acc = flowAccumulation(g, {
      receiver: Int32Array.from([1, 0]),
      direction: Int8Array.from([0, 4]),
      status: Uint8Array.from([0, 0]),
      sinkCount: 0, flatCount: 0, outletCount: 0,
    });
    expect(acc.unresolvedCells).toBe(2);
    expect(acc.drainedCells).toBe(0);
  });
});

describe('catchment', () => {
  it('is empty for a NoData outlet', () => {
    const g = gridOf([[1, null]]);
    expect([...catchmentOf(g, d8Flow(g), 1)].every((v) => v === 0)).toBe(true);
  });

  it('includes the outlet itself even when nothing drains into it', () => {
    const g = gridOf([[5, 4, 3]]);
    const d8 = d8Flow(g);
    expect(catchmentOf(g, d8, 0)[0]).toBe(1);
    expect([...catchmentOf(g, d8, 0)].filter((v) => v === 1).length).toBe(1);
  });
});
