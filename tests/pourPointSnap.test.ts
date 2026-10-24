/**
 * pourPointSnap.test.ts — a clicked outlet moves to the strongest channel nearby.
 *
 * Within a square window of the stated radius, the cell with the highest
 * upstream count wins; ties keep the clicked cell, then the nearest; NoData is
 * never chosen; a click outside the grid comes back unchanged.
 */
import { describe, expect, it } from 'vitest';
import { POUR_POINT_SNAP_RADIUS_CELLS, snapPourPoint } from '../src/simulation/flowPulse/pourPointSnap';
import { CELL_NODATA, CELL_ROUTED } from '../src/simulation/flowPulse/flowTypes';

const cols = 7, rows = 7;
const status = new Uint8Array(cols * rows).fill(CELL_ROUTED);
/** A channel in column 3: upstream counts 100..106 northwards; hillslope cells count 1. */
const up = new Uint32Array(cols * rows).fill(1);
for (let r = 0; r < rows; r++) up[r * cols + 3] = 100 + r;

describe('pour-point snapping', () => {
  it('snaps a click two cells off the channel onto it', () => {
    const s = snapPourPoint(cols, rows, status, up, { col: 1, row: 3 });
    expect(POUR_POINT_SNAP_RADIUS_CELLS).toBe(2);
    expect(s.snapped).toBe(true);
    // Highest count within rows 1..5 of column 3 is row 5.
    expect(s.cell).toEqual({ col: 3, row: 5 });
    expect(s.from).toEqual({ col: 1, row: 3 });
  });

  it('does not reach beyond the radius', () => {
    const s = snapPourPoint(cols, rows, status, up, { col: 0, row: 3 });
    expect(s.snapped).toBe(false);
    expect(s.cell).toEqual({ col: 0, row: 3 });
  });

  it('keeps the clicked cell when nothing nearby drains more', () => {
    const s = snapPourPoint(cols, rows, status, up, { col: 3, row: 6 });
    expect(s.snapped).toBe(false);
  });

  it('breaks a tie towards the clicked cell, then the nearest cell', () => {
    const flat = new Uint32Array(cols * rows).fill(5);
    expect(snapPourPoint(cols, rows, status, flat, { col: 3, row: 3 }).snapped).toBe(false);
    const two = new Uint32Array(cols * rows).fill(1);
    two[3 * cols + 5] = 9; // two cells east
    two[3 * cols + 2] = 9; // one cell west: nearer
    expect(snapPourPoint(cols, rows, status, two, { col: 3, row: 3 }).cell).toEqual({ col: 2, row: 3 });
  });

  it('never picks NoData, and leaves an out-of-grid click alone', () => {
    const st = status.slice();
    for (let r = 0; r < rows; r++) st[r * cols + 3] = CELL_NODATA;
    const s = snapPourPoint(cols, rows, st, up, { col: 2, row: 3 });
    expect(s.cell.col).not.toBe(3);
    expect(snapPourPoint(cols, rows, status, up, { col: -1, row: 0 }).snapped).toBe(false);
  });

  it('a radius of 0 never moves the outlet', () => {
    expect(snapPourPoint(cols, rows, status, up, { col: 2, row: 3 }, 0).snapped).toBe(false);
  });
});
