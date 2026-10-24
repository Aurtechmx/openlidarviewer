/**
 * flowLength.test.ts — D8 flow length to an outlet, on synthetic D8 trees.
 *
 * Hand values: an orthogonal step is one cell length, a diagonal step √2 cell
 * lengths on a square grid and hypot(dx·mx, dy·my) on an anisotropic one; a
 * branching tree sums each branch's own steps; cells that do not drain to the
 * outlet carry NaN; the set of cells with a length is the catchment.
 */
import { describe, expect, it } from 'vitest';
import { flowLengthToOutlet } from '../src/simulation/flowPulse/flowLength';
import { catchmentOf } from '../src/simulation/flowPulse/flowAccumulation';
import { D8_NEIGHBOURS, CELL_NODATA, CELL_OUTLET, CELL_ROUTED, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import type { D8Result } from '../src/simulation/flowPulse/d8Flow';

function grid(cols: number, rows: number, mx = 1, my = mx): FlowGrid {
  return { z: new Float32Array(cols * rows), valid: new Uint8Array(cols * rows).fill(1), cols, rows, cellMetresX: mx, cellMetresY: my };
}

/** A D8 result from receivers alone; the direction index is derived from the offset. */
function routedOf(g: FlowGrid, receiver: number[]): D8Result {
  const n = g.cols * g.rows;
  const direction = new Int8Array(n).fill(-1);
  const status = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = receiver[i]!;
    if (r === -2) { status[i] = CELL_NODATA; receiver[i] = -1; continue; }
    if (r < 0) { status[i] = CELL_OUTLET; continue; }
    status[i] = CELL_ROUTED;
    const dx = (r % g.cols) - (i % g.cols), dy = Math.floor(r / g.cols) - Math.floor(i / g.cols);
    direction[i] = D8_NEIGHBOURS.findIndex(([a, b]) => a === dx && b === dy);
  }
  return { receiver: Int32Array.from(receiver), direction, status, sinkCount: 0, flatCount: 0, outletCount: 0 };
}

describe('flow length to the outlet', () => {
  it('a straight orthogonal line: multiples of the cell size', () => {
    // 5 x 1 strip draining east into cell 4, 2 m cells.
    const g = grid(5, 1, 2);
    const fl = flowLengthToOutlet(g, routedOf(g, [1, 2, 3, 4, -1]), 4);
    expect(Array.from(fl.length)).toEqual([8, 6, 4, 2, 0]);
    expect(fl.maxLength).toBe(8);
    expect(fl.cells).toBe(5);
  });

  it('a diagonal line: √2 cell sizes per step', () => {
    // 3 x 3, the diagonal (0,0) -> (1,1) -> (2,2); 3 m cells.
    const g = grid(3, 3, 3);
    const rec = Array(9).fill(-1);
    rec[0] = 4; rec[4] = 8;
    const fl = flowLengthToOutlet(g, routedOf(g, rec), 8);
    expect(fl.length[8]).toBe(0);
    expect(fl.length[4]).toBeCloseTo(3 * Math.SQRT2, 12);
    expect(fl.length[0]).toBeCloseTo(6 * Math.SQRT2, 12);
    for (const i of [1, 2, 3, 5, 6, 7]) expect(Number.isNaN(fl.length[i]!)).toBe(true);
  });

  it('a branching tree sums each branch, and matches the catchment exactly', () => {
    // 3 x 3 (row 0 south). Outlet at (1,0). (1,1) -> outlet (N->S step);
    // (0,2) -> (1,1) diagonal; (2,2) -> (1,1) diagonal; (1,2) -> (1,1);
    // (0,1) -> (1,0) diagonal; (2,1) and (0,0), (2,0) drain elsewhere.
    const g = grid(3, 3, 1);
    const idx = (c: number, r: number) => r * 3 + c;
    const rec = Array(9).fill(-1);
    rec[idx(1, 1)] = idx(1, 0);
    rec[idx(0, 2)] = idx(1, 1);
    rec[idx(2, 2)] = idx(1, 1);
    rec[idx(1, 2)] = idx(1, 1);
    rec[idx(0, 1)] = idx(1, 0);
    rec[idx(2, 1)] = idx(2, 0);
    const routed = routedOf(g, rec);
    const fl = flowLengthToOutlet(g, routed, idx(1, 0));
    expect(fl.length[idx(1, 0)]).toBe(0);
    expect(fl.length[idx(1, 1)]).toBe(1);
    expect(fl.length[idx(1, 2)]).toBe(2);
    expect(fl.length[idx(0, 2)]).toBeCloseTo(1 + Math.SQRT2, 12);
    expect(fl.length[idx(2, 2)]).toBeCloseTo(1 + Math.SQRT2, 12);
    expect(fl.length[idx(0, 1)]).toBeCloseTo(Math.SQRT2, 12);
    expect(fl.maxLength).toBeCloseTo(1 + Math.SQRT2, 12);
    const mask = catchmentOf(g, routed, idx(1, 0));
    for (let i = 0; i < 9; i++) expect(Number.isNaN(fl.length[i]!) ? 0 : 1).toBe(mask[i]);
    expect(fl.cells).toBe(mask.reduce((a, b) => a + b, 0));
  });

  it('an anisotropic grid uses the physical step on each axis', () => {
    // 2 m east-west, 3 m north-south: a diagonal step is √13 m.
    const g = grid(2, 2, 2, 3);
    const rec = [-1, -1, -1, 0]; // (1,1) -> (0,0) diagonal; (0,1) none
    const fl = flowLengthToOutlet(g, routedOf(g, rec), 0);
    expect(fl.length[3]).toBeCloseTo(Math.sqrt(13), 12);
    const north = routedOf(g, [-1, -1, 0, -1]); // (0,1) -> (0,0): one north-south step
    expect(flowLengthToOutlet(g, north, 0).length[2]).toBe(3);
  });

  it('in cell lengths the east-west cell is the unit', () => {
    const g = grid(5, 1, 2);
    const fl = flowLengthToOutlet(g, routedOf(g, [1, 2, 3, 4, -1]), 4, 'cells');
    expect(Array.from(fl.length)).toEqual([4, 3, 2, 1, 0]);
    expect(fl.unit).toBe('cells');
  });

  it('a NoData or out-of-grid outlet has no catchment', () => {
    const g = grid(3, 1);
    const fl = flowLengthToOutlet(g, routedOf(g, [1, -2, -1]), 1);
    expect(fl.cells).toBe(0);
    expect(flowLengthToOutlet(g, routedOf(g, [1, 2, -1]), 7).cells).toBe(0);
  });
});
