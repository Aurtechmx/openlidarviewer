/**
 * watershedPartition.test.ts — every routed cell belongs to the watershed of
 * the terminal its flow ends at.
 *
 * Hand-built grids pin the labelling, the largest-first order with its
 * terminal-index tie-break, the open/complete flag, the share of boundary
 * cells that take inflow across the survey edge, and the minor grouping.
 */
import { describe, expect, it } from 'vitest';
import { d8Flow, type D8Result } from '../src/simulation/flowPulse/d8Flow';
import { flowAccumulation } from '../src/simulation/flowPulse/flowAccumulation';
import { edgeContamination } from '../src/simulation/flowPulse/edgeContamination';
import { partitionWatersheds } from '../src/simulation/flowPulse/watershed/watershedPartition';
import { CELL_NODATA, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';

/** Row 0 is the southern row; `height` returns null for NoData. */
function gridFrom(cols: number, rows: number, height: (col: number, row: number) => number | null): FlowGrid {
  const z = new Float32Array(cols * rows), valid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = height(c, r);
      if (v == null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: 1, cellMetresY: 1 };
}

function partition(grid: FlowGrid, minShare?: number, routed: D8Result = d8Flow(grid)) {
  const acc = flowAccumulation(grid, routed);
  const edge = edgeContamination(grid, routed);
  return partitionWatersheds(grid, routed, acc, edge, minShare);
}

const idx = (g: FlowGrid, col: number, row: number) => row * g.cols + col;

describe('partitionWatersheds', () => {
  it('labels every routed cell with the watershed of its terminal', () => {
    // A ridge down column 2, falling to both side edges and to the south row.
    const g = gridFrom(5, 4, (c, r) => 10 - Math.abs(c - 2) * 2 + 0.1 * r);
    const p = partition(g);
    expect(p.watersheds).toHaveLength(2);
    expect(p.watersheds.reduce((s, w) => s + w.cells, 0)).toBe(20);
    expect(p.watersheds.map((w) => w.terminal).sort((a, b) => a - b)).toEqual([idx(g, 0, 0), idx(g, 4, 0)]);
    const west = p.watersheds.find((w) => w.terminal === idx(g, 0, 0))!;
    const east = p.watersheds.find((w) => w.terminal === idx(g, 4, 0))!;
    // The ridge cells drain east by the fixed neighbour order.
    expect([west.cells, east.cells]).toEqual([8, 12]);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        expect(p.label[idx(g, c, r)]).toBe(c < 2 ? west.id : east.id);
      }
    }
  });

  it('orders watersheds largest first and breaks ties by terminal index', () => {
    const uneven = partition(gridFrom(5, 4, (c, r) => 10 - Math.abs(c - 2) * 2 + 0.1 * r));
    expect(uneven.watersheds.map((w) => w.id)).toEqual([1, 2]);
    expect(uneven.watersheds.map((w) => w.cells)).toEqual([12, 8]);

    // Two equal halves split between columns 1 and 2.
    const g = gridFrom(4, 3, (c, r) => [6, 8, 8, 6][c]! + 0.1 * r);
    const even = partition(g);
    expect(even.watersheds.map((w) => w.cells)).toEqual([6, 6]);
    expect(even.watersheds.map((w) => w.terminal)).toEqual([idx(g, 0, 0), idx(g, 3, 0)]);
    expect(even.label[idx(g, 0, 2)]).toBe(1);
    expect(even.label[idx(g, 3, 2)]).toBe(2);
  });

  it('marks a watershed open when any cell is edge-contaminated', () => {
    // A ramp falling east: every west-edge cell takes water in from outside the survey.
    const g = gridFrom(6, 3, (c, r) => 10 - c + 0.1 * r);
    const p = partition(g);
    expect(p.watersheds).toHaveLength(1);
    const w = p.watersheds[0]!;
    expect(w.terminal).toBe(idx(g, 5, 0));
    expect(w.cells).toBe(18);
    expect(w.complete).toBe(false);
    // Boundary is the 14 perimeter cells; every one except the terminal routes onward.
    expect(w.edgeInflowShare).toBeCloseTo(13 / 14, 12);
  });

  it('marks a watershed complete when no edge cell routes into it', () => {
    // A dome inside a flat ring: every ring cell is an outlet, none takes inflow.
    const g = gridFrom(5, 5, (c, r) => (c === 0 || r === 0 || c === 4 || r === 4 ? 0 : 5 - Math.abs(c - 2) - Math.abs(r - 2)));
    const p = partition(g);
    expect(p.watersheds.length).toBeGreaterThan(0);
    for (const w of p.watersheds) {
      expect(w.complete).toBe(true);
      expect(w.edgeInflowShare).toBe(0);
    }
    expect(p.watersheds.reduce((s, w) => s + w.cells, 0)).toBe(25);
  });

  it('groups watersheds under the minimum share as minor', () => {
    // 300 cells in one row: a 2-cell edge drain beside a 298-cell slope.
    const z300 = (i: number) => (i === 0 ? 12 : i === 1 ? 10 : i === 2 ? 11 : 5 - (i - 3) * 0.01);
    const small = partition(gridFrom(300, 1, (c) => z300(c)));
    expect(small.watersheds.map((w) => w.cells)).toEqual([298, 2]);
    expect(small.watersheds.map((w) => w.minor)).toEqual([false, true]);

    // 100 cells: a single-cell drain is exactly 0.01 of the readable cells, which is not under it.
    const z100 = (i: number) => (i === 0 ? 10 : i === 1 ? 11 : 5 - (i - 2) * 0.01);
    const edge = partition(gridFrom(100, 1, (c) => z100(c)));
    expect(edge.watersheds.map((w) => w.cells)).toEqual([99, 1]);
    expect(edge.watersheds[1]!.minor).toBe(false);
    // A larger minimum share tips it over.
    expect(partition(gridFrom(100, 1, (c) => z100(c)), 0.02).watersheds[1]!.minor).toBe(true);
  });

  it('leaves NoData at label 0', () => {
    // A NoData column splits a slope; the hole itself is never labelled.
    const g = gridFrom(5, 3, (c, r) => (c === 2 ? null : 10 - c + 0.1 * r));
    const p = partition(g);
    for (let r = 0; r < 3; r++) expect(p.label[idx(g, 2, r)]).toBe(0);
    const labelled = Array.from(p.label).filter((v) => v > 0).length;
    expect(labelled).toBe(12);
    expect(p.watersheds.reduce((s, w) => s + w.cells, 0)).toBe(12);
  });

  it('leaves cells in a receiver cycle unlabelled', () => {
    // Hand-built routing: cells 0 and 1 send to each other; cell 2 is a lone outlet.
    const g = gridFrom(3, 1, () => 1);
    const routed: D8Result = {
      receiver: Int32Array.from([1, 0, -1]),
      direction: new Int8Array(3),
      status: new Uint8Array(3),
      sinkCount: 0, flatCount: 0, outletCount: 1,
    };
    expect(routed.status.every((s) => s !== CELL_NODATA)).toBe(true);
    const p = partition(g, undefined, routed);
    expect(Array.from(p.label)).toEqual([0, 0, 1]);
    expect(p.watersheds).toHaveLength(1);
  });
});
