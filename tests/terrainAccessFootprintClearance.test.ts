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

  it('grows a single blocked cell into its physical-radius neighbourhood', () => {
    // 5×5 grid, 1 m cells, one blocked cell at the centre, width 2 m (radius 1 m).
    const n = 25;
    const blocked = new Uint8Array(n);
    blocked[2 * 5 + 2] = 1;
    const dilated = dilateBlocked(blocked, 5, 5, 1, 1, 2);
    // The four orthogonal neighbours (1 m away) are within radius; the four
    // diagonal neighbours (√2 m away) are NOT within a 1 m radius.
    expect(dilated[1 * 5 + 2]).toBe(1); // north
    expect(dilated[3 * 5 + 2]).toBe(1); // south
    expect(dilated[2 * 5 + 1]).toBe(1); // west
    expect(dilated[2 * 5 + 3]).toBe(1); // east
    expect(dilated[1 * 5 + 1]).toBe(0); // NW diagonal, √2 m away
    expect(dilated[0 * 5 + 0]).toBe(0); // far corner
  });

  it('uses true physical distance on an anisotropic grid, not a square window', () => {
    // 10 m east-west cells, 1 m north-south cells, width 4 m (radius 2 m).
    const blocked = new Uint8Array(9); // 3×3
    blocked[1 * 3 + 1] = 1; // centre
    const dilated = dilateBlocked(blocked, 3, 3, 10, 1, 4);
    // One cell east/west is 10 m away — outside a 2 m radius.
    expect(dilated[1 * 3 + 0]).toBe(0);
    expect(dilated[1 * 3 + 2]).toBe(0);
    // One cell north/south is 1 m away — inside a 2 m radius.
    expect(dilated[0 * 3 + 1]).toBe(1);
    expect(dilated[2 * 3 + 1]).toBe(1);
  });

  it('TA-5: a corridor one cell wide disappears once the vehicle width exceeds it', () => {
    // A 1-cell-wide gap between two blocked walls, 1 m cells.
    //   blocked  open  blocked
    const blocked = new Uint8Array([1, 0, 1]);
    // Half-width 0.4 m clears the 1 m gap (its centreline is 1 m from each wall's
    // own cell centre, well outside a 0.4 m radius).
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
