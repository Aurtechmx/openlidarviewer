/**
 * edgeContamination.test.ts — Lindsay's D8 edge-contamination flag.
 *
 * A cell is contaminated when its upslope area holds a survey-edge cell that
 * routes into the surface; a catchment is contaminated exactly when its outlet
 * cell is. Hand-built grids pin the seeds (edge cells with a receiver, beside
 * the grid border or NoData outside the survey, never a hole the survey
 * encloses), the downstream propagation, and the catchment rule.
 */
import { describe, expect, it } from 'vitest';
import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { catchmentOf } from '../src/simulation/flowPulse/flowAccumulation';
import { edgeContamination, surveyEdgeCells } from '../src/simulation/flowPulse/edgeContamination';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

/** Rows are given north first, as read; row 0 of the grid is the southern row. */
function gridOf(northFirst: (number | null)[][]): FlowGrid {
  const rows = northFirst.length, cols = northFirst[0]!.length;
  const z = new Float32Array(rows * cols), valid = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = northFirst[rows - 1 - r]![c];
      if (v == null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: 1, cellMetresY: 1 };
}

const at = (g: FlowGrid, col: number, northRow: number) => (g.rows - 1 - northRow) * g.cols + col;

describe('survey edge cells', () => {
  it('are the grid border and cells beside NoData that reaches it, not a hole the survey encloses', () => {
    const g = gridOf([
      [null, 5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5, 5],
      [5, 5, 5, null, 5, 5],
      [5, 5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5, 5],
      [5, 5, 5, 5, 5, 5],
    ]);
    const e = surveyEdgeCells(g);
    // Border cells are edge cells; the corner NoData is outside, so its diagonal neighbour is too.
    expect(e[at(g, 1, 0)]).toBe(1);
    expect(e[at(g, 1, 1)]).toBe(1);
    // The hole at (3, 2) is enclosed: its neighbours are interior.
    expect(e[at(g, 2, 2)]).toBe(0);
    expect(e[at(g, 4, 3)]).toBe(0);
    expect(e[at(g, 0, 2)]).toBe(1);
    // NoData itself is never flagged.
    expect(e[at(g, 0, 0)]).toBe(0);
  });
});

describe('contamination', () => {
  it('a valley entering the survey at its north edge contaminates everything downstream of the entry', () => {
    // Valley floor in column 2, falling south; the walls fall towards it.
    const g = gridOf([
      [9, 8, 7, 8, 9],
      [8, 7, 6, 7, 8],
      [7, 6, 5, 6, 7],
      [6, 5, 4, 5, 6],
      [5, 4, 3, 4, 5],
    ]);
    const routed = d8Flow(g);
    const ec = edgeContamination(g, routed);
    // The north-edge valley cell routes south, into the survey: a seed.
    expect(routed.receiver[at(g, 2, 0)]).toBe(at(g, 2, 1));
    // Every valley cell below it is contaminated, and the outlet with it.
    for (let r = 0; r < 5; r++) expect(ec.contaminated[at(g, 2, r)]).toBe(1);
    // The catchment of the valley's last interior cell is contaminated because its outlet cell is.
    const outlet = at(g, 2, 3);
    const mask = catchmentOf(g, routed, outlet);
    expect(mask[at(g, 2, 0)]).toBe(1);
    expect(ec.contaminated[outlet]).toBe(1);
  });

  it('a dome draining off every side contaminates only cells fed from the rim, not its interior', () => {
    // A cone: the centre is highest and every edge cell is lower than any interior cell.
    const n = 7, mid = 3;
    const rows: number[][] = [];
    for (let r = 0; r < n; r++) rows.push(Array.from({ length: n }, (_, c) => 20 - Math.hypot(c - mid, r - mid)));
    const g = gridOf(rows);
    const routed = d8Flow(g);
    const ec = edgeContamination(g, routed);
    // No interior cell is fed from the edge, so none is contaminated.
    for (let r = 1; r < n - 1; r++) {
      for (let c = 1; c < n - 1; c++) expect(ec.contaminated[at(g, c, r)], `(${c}, ${r})`).toBe(0);
    }
    // The catchment of an interior cell is therefore not contaminated.
    expect(ec.contaminated[at(g, mid, mid - 1)]).toBe(0);
    // Edge cells that route along the edge are seeds, and the corner they reach is flagged.
    expect(ec.inwardEdgeCells).toBeGreaterThan(0);
    expect(ec.contaminated[at(g, 0, 0)]).toBe(1);
  });

  it('a terminal edge cell is not a seed: a plane falling off one side drains its own interior cleanly', () => {
    // Falls west; rows 1..3 of the interior drain to west-edge outlets.
    const g = gridOf([
      [null, null, null, null, null],
      [null, 1, 2, 3, null],
      [null, 1, 2, 3, null],
      [null, 1, 2, 3, null],
      [null, null, null, null, null],
    ]);
    const routed = d8Flow(g);
    const ec = edgeContamination(g, routed);
    // The west column are outlets (beside NoData outside the survey): terminal, not seeds.
    expect(routed.receiver[at(g, 1, 2)]).toBe(-1);
    // The east column and the middle column's north and south cells are edge
    // cells that route west, inward: those five are the seeds.
    expect(ec.inwardEdgeCells).toBe(5);
    // So every valid cell here is contaminated (every row starts at the east edge).
    expect(ec.contaminatedCells).toBe(9);
  });

  it('marks nothing on a surface whose only edge cells are terminal', () => {
    // A single valid cell has no receiver: it is an outlet, not a seed.
    const g = gridOf([[null, null, null], [null, 4, null], [null, null, null]]);
    const ec = edgeContamination(g, d8Flow(g));
    expect(ec.contaminatedCells).toBe(0);
  });
});
