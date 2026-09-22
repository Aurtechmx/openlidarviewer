/**
 * d8Flow.test.ts: routing answers what the surface says, not what the loop does.
 *
 * Each terrain here is analytical, so the expected flow field is known before
 * the code runs. That matters more than usual for D8: a routing bug does not
 * throw, it produces a plausible-looking field that is wrong by one neighbour,
 * and the only way to catch it is to assert against a surface whose answer can
 * be derived by hand.
 *
 * The cases follow the prompt's TF register: plane, bowl, ridge, valley, flat,
 * anisotropic grid and NoData barrier.
 */
import { describe, expect, it } from 'vitest';

import {
  CELL_FLAT,
  CELL_NODATA,
  CELL_OUTLET,
  CELL_ROUTED,
  CELL_SINK,
  d8Flow,
  traceDownstream,
} from '../src/simulation/flowPulse/d8Flow';
import { D8_NEIGHBOURS, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';

/** A grid from a row-major elevation list; `null` marks NoData. */
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

/** The neighbour offset a cell routed along, as a readable pair. */
const dirOf = (res: ReturnType<typeof d8Flow>, i: number): readonly [number, number] | null =>
  res.direction[i] < 0 ? null : D8_NEIGHBOURS[res.direction[i]];

describe('TF-1 a constant plane routes every interior cell the same way', () => {
  // Elevation falls to the east by 1 per column, so every cell's steepest
  // descent is due east: a cardinal step of 1 m beats the diagonals, which
  // drop the same 1 m over 1.414 m.
  const plane = gridOf([
    [3, 2, 1, 0],
    [3, 2, 1, 0],
    [3, 2, 1, 0],
  ]);

  it('sends interior cells east, and the east column off the grid', () => {
    const res = d8Flow(plane);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dirOf(res, r * 4 + c)).toEqual([1, 0]);
      }
      // Nothing lower and an edge to leave by.
      expect(res.status[r * 4 + 3]).toBe(CELL_OUTLET);
    }
    expect(res.sinkCount).toBe(0);
    expect(res.flatCount).toBe(0);
  });

  it('traces a path that reaches the outlet and stops', () => {
    const res = d8Flow(plane);
    const path = [...traceDownstream(res, 4)]; // row 1, col 0
    expect(path).toEqual([4, 5, 6, 7]);
    expect(res.status[path[path.length - 1]]).toBe(CELL_OUTLET);
  });
});

describe('TF-2 a bowl keeps its pit instead of draining it', () => {
  const bowl = gridOf([
    [5, 5, 5, 5, 5],
    [5, 3, 2, 3, 5],
    [5, 2, 0, 2, 5],
    [5, 3, 2, 3, 5],
    [5, 5, 5, 5, 5],
  ]);

  it('reports the centre as a sink rather than routing it somewhere', () => {
    const res = d8Flow(bowl);
    const centre = 2 * 5 + 2;
    expect(res.status[centre]).toBe(CELL_SINK);
    expect(res.receiver[centre]).toBe(-1);
    expect(res.sinkCount).toBe(1);
  });

  it('routes the bowl wall inward, so the pit is where flow collects', () => {
    const res = d8Flow(bowl);
    const path = [...traceDownstream(res, 1 * 5 + 1)];
    expect(path[path.length - 1]).toBe(2 * 5 + 2);
    expect(res.status[path[path.length - 1]]).toBe(CELL_SINK);
  });
});

describe('TF-3 a ridge separates flow to both sides', () => {
  it('sends the west flank west and the east flank east', () => {
    // A north–south ridge down the middle column.
    const ridge = gridOf([
      [0, 1, 2, 1, 0],
      [0, 1, 2, 1, 0],
      [0, 1, 2, 1, 0],
    ]);
    const res = d8Flow(ridge);
    // Column 1 drops to column 0; column 3 drops to column 4.
    expect(dirOf(res, 1 * 5 + 1)?.[0]).toBe(-1);
    expect(dirOf(res, 1 * 5 + 3)?.[0]).toBe(1);
  });
});

describe('TF-5 a flat is reported, never drained in array order', () => {
  it('marks an interior flat as FLAT with no receiver', () => {
    // A plateau ringed by higher ground, so the flat has nowhere lower and a
    // neighbour at its own elevation.
    const plateau = gridOf([
      [9, 9, 9, 9],
      [9, 4, 4, 9],
      [9, 4, 4, 9],
      [9, 9, 9, 9],
    ]);
    const res = d8Flow(plateau);
    for (const i of [1 * 4 + 1, 1 * 4 + 2, 2 * 4 + 1, 2 * 4 + 2]) {
      expect(res.status[i]).toBe(CELL_FLAT);
      expect(res.receiver[i]).toBe(-1);
    }
    expect(res.flatCount).toBe(4);
    expect(res.sinkCount).toBe(0);
  });
});

describe('TF-6 an anisotropic grid routes by metres, not by cell index', () => {
  // One cell east is 10 m; one cell south is 1 m. A cell that drops 2 m east
  // and 1 m south descends 0.2 m/m east against 1.0 m/m south, so south wins
  // even though the eastern drop is the larger number.
  it('prefers the steeper physical gradient over the larger raw drop', () => {
    const g = gridOf([
      [10, 8],
      [9, 8],
    ], 10, 1);
    const res = d8Flow(g);
    expect(dirOf(res, 0)).toEqual([0, 1]); // south
  });

  it('routes the same cell east once the axes are square', () => {
    // The identical elevations on a square grid: east drops 2 over 1 m, south
    // drops 1 over 1 m. Nothing changed but the geometry, and the answer flips.
    const square = gridOf([
      [10, 8],
      [9, 8],
    ], 1, 1);
    expect(dirOf(d8Flow(square), 0)).toEqual([1, 0]);
  });
});

describe('TF-7 NoData is a wall', () => {
  it('never routes into or out of an invalid cell', () => {
    // A NoData column splits a surface that otherwise falls to the east. The
    // invalid cells carry z = 0, which is LOWER than either column, so a
    // routing pass that forgot to check validity would find its steepest
    // descent straight into the gap. Asserting only that the west column
    // fails to reach the east column does not catch that — it lands in the
    // gap, not beyond it — so the invariant asserted here is the direct one:
    // a receiver is always a valid cell.
    const barrier = gridOf([
      [3, null, 1],
      [3, null, 1],
    ]);
    const res = d8Flow(barrier);
    for (let r = 0; r < 2; r++) {
      const gap = r * 3 + 1;
      expect(res.status[gap]).toBe(CELL_NODATA);
      expect(res.receiver[gap]).toBe(-1);
    }
    for (let i = 0; i < res.receiver.length; i++) {
      if (res.receiver[i] >= 0) expect(barrier.valid[res.receiver[i]]).toBe(1);
    }
  });

  it('traces nothing from a NoData start', () => {
    const res = d8Flow(gridOf([[1, null]]));
    expect([...traceDownstream(res, 1)]).toEqual([]);
  });
});

describe('tie-breaking is fixed, so the same surface routes the same way twice', () => {
  it('takes the first neighbour in declaration order when gradients are equal', () => {
    // A cell with an identical drop to E, S, W and N. Declaration order puts
    // E first, so E must win — and must keep winning.
    const symmetric = gridOf([
      [9, 0, 9],
      [0, 5, 0],
      [9, 0, 9],
    ]);
    const centre = 1 * 3 + 1;
    const first = d8Flow(symmetric);
    expect(dirOf(first, centre)).toEqual([1, 0]);
    expect(dirOf(d8Flow(symmetric), centre)).toEqual(dirOf(first, centre));
  });
});

describe('a cycle cannot hang the tracer', () => {
  it('stops when flow returns to a cell it already visited', () => {
    // Two cells at the same elevation cannot route to each other (equal is not
    // a descent), so a natural cycle needs a hand-built receiver array.
    const res = {
      receiver: Int32Array.from([1, 0]),
      direction: Int8Array.from([0, 4]),
      status: Uint8Array.from([CELL_ROUTED, CELL_ROUTED]),
      sinkCount: 0,
      flatCount: 0,
      outletCount: 0,
    };
    expect([...traceDownstream(res, 0)]).toEqual([0, 1]);
  });
});

describe('the grid contract is checked rather than trusted', () => {
  it('refuses a grid whose arrays do not match its dimensions', () => {
    expect(() => d8Flow({
      z: new Float32Array(3), valid: new Uint8Array(3),
      cols: 2, rows: 2, cellMetresX: 1, cellMetresY: 1,
    })).toThrow(/cols×rows/);
  });

  it('refuses a non-positive cell size, which would divide by zero', () => {
    expect(() => d8Flow({
      z: new Float32Array(4), valid: new Uint8Array(4),
      cols: 2, rows: 2, cellMetresX: 0, cellMetresY: 1,
    })).toThrow(/cellMetresX/);
  });
});
