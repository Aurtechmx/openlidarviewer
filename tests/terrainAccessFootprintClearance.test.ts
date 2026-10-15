/**
 * terrainAccessFootprintClearance.test.ts: width dilation, and TA-5 — a
 * point-like path through a gap narrower than the declared vehicle width
 * must not survive width-aware eligibility.
 */
import { describe, expect, it } from 'vitest';

import { dilateBlocked } from '../src/simulation/terrainAccess/footprintClearance';

describe('dilateBlocked', () => {
  it('leaves the mask unchanged for a zero or non-finite width', () => {
    const blocked = new Uint8Array([0, 1, 0, 0]);
    expect([...dilateBlocked(blocked, 4, 1, 1, 1, 0)]).toEqual([0, 1, 0, 0]);
    expect([...dilateBlocked(blocked, 4, 1, 1, 1, Number.NaN)]).toEqual([0, 1, 0, 0]);
  });

  it('grows a single blocked cell by distance to its RECTANGLE, not its centre', () => {
    // 9×9 grid, 1 m cells, one blocked cell at (4,4), width 2 m (radius 1 m).
    // Distance from a cell centre to the blocked rectangle is
    // hypot(max(|dc| − ½, 0), max(|dr| − ½, 0)) m. This previously measured
    // centre to centre, which kept the diagonal neighbours (√2 > 1) although
    // the blocked square's corner is only √0.5 ≈ 0.707 m away.
    const blocked = new Uint8Array(81);
    blocked[4 * 9 + 4] = 1;
    const dilated = dilateBlocked(blocked, 9, 9, 1, 1, 2);
    expect(dilated[3 * 9 + 4]).toBe(1); // north, 0.5 m
    expect(dilated[4 * 9 + 5]).toBe(1); // east, 0.5 m
    expect(dilated[3 * 9 + 3]).toBe(1); // NW diagonal, 0.707 m
    expect(dilated[2 * 9 + 4]).toBe(0); // two north, 1.5 m
    expect(dilated[2 * 9 + 3]).toBe(0); // knight's move, hypot(1.5, 0.5) ≈ 1.58 m
    // The survey edge is unsupported too: the outer ring is 0.5 m from it,
    // the next ring 1.5 m.
    expect(dilated[0]).toBe(1);
    expect(dilated[1 * 9 + 1]).toBe(0);
  });

  it('uses true physical distance on an anisotropic grid, not a square window', () => {
    // 10 m east-west cells, 1 m north-south cells, width 4 m (radius 2 m);
    // 3 cols × 11 rows so the survey edge (5 m east/west, ≥ 2.5 m north/south
    // of the cells checked) does not decide any expectation below.
    const blocked = new Uint8Array(33);
    blocked[5 * 3 + 1] = 1; // (5, 1)
    const dilated = dilateBlocked(blocked, 3, 11, 10, 1, 4);
    // One cell east/west: 10 − 5 = 5 m from the rectangle, outside 2 m.
    expect(dilated[5 * 3 + 0]).toBe(0);
    expect(dilated[5 * 3 + 2]).toBe(0);
    // One and two cells north/south: 0.5 m and 1.5 m, inside 2 m.
    expect(dilated[4 * 3 + 1]).toBe(1);
    expect(dilated[6 * 3 + 1]).toBe(1);
    expect(dilated[3 * 3 + 1]).toBe(1);
    // Three cells north: 2.5 m, outside.
    expect(dilated[2 * 3 + 1]).toBe(0);
  });

  it('TA-5: a corridor one cell wide disappears once the vehicle width exceeds it', () => {
    // A 1-cell-wide gap between two blocked walls, 1 m cells.
    //   blocked  open  blocked
    const blocked = new Uint8Array([1, 0, 1]);
    // Half-width 0.4 m clears the 1 m gap (its centreline is 0.5 m from each
    // wall cell's edge, and 0.5 m from the survey edge above and below).
    const narrow = dilateBlocked(blocked, 3, 1, 1, 1, 0.8);
    expect(narrow[1]).toBe(0);
    // Half-width 1.0 m (width 2 m) reaches the gap cell from both walls.
    const wide = dilateBlocked(blocked, 3, 1, 1, 1, 2.0);
    expect(wide[1]).toBe(1);
  });

  it('does not mutate its input', () => {
    const blocked = new Uint8Array([0, 1, 0]);
    const copy = blocked.slice();
    dilateBlocked(blocked, 3, 1, 1, 1, 5);
    expect([...blocked]).toEqual([...copy]);
  });
});
