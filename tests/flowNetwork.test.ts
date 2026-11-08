/**
 * flowNetwork.test.ts — where flow concentrates into lines, how those lines
 * split at confluences, and the Strahler order of each piece.
 *
 * A V-valley pins the contributing-area threshold on real routing. The
 * confluence, length and clipping cases use hand-written receivers, so each
 * expected number can be read straight off the drawing in the test.
 */
import { describe, expect, it } from 'vitest';
import { d8Flow, type D8Result } from '../src/simulation/flowPulse/d8Flow';
import { flowAccumulation, contributingAreaM2 } from '../src/simulation/flowPulse/flowAccumulation';
import { buildFlowNetwork, networkWithin } from '../src/simulation/flowPulse/watershed/flowNetwork';
import { CELL_ROUTED, CELL_OUTLET, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function flatGrid(cols: number, rows: number, cellMetresX = 1, cellMetresY = 1): FlowGrid {
  return {
    z: new Float32Array(cols * rows),
    valid: new Uint8Array(cols * rows).fill(1),
    cols, rows, cellMetresX, cellMetresY,
  };
}

/** Receivers by [col,row] pairs: `to` maps a cell to the cell it drains into. */
function routedFrom(grid: FlowGrid, edges: readonly [[number, number], [number, number]][]): D8Result {
  const n = grid.cols * grid.rows;
  const receiver = new Int32Array(n).fill(-1);
  const status = new Uint8Array(n).fill(CELL_OUTLET);
  const at = ([c, r]: [number, number]) => r * grid.cols + c;
  for (const [from, to] of edges) {
    receiver[at(from)] = at(to);
    status[at(from)] = CELL_ROUTED;
  }
  return { receiver, direction: new Int8Array(n).fill(-1), status, sinkCount: 0, flatCount: 0, outletCount: 0 };
}

/** 100 m² on every cell the drawing mentions, 0 elsewhere, so only the drawn lines are network. */
function areaFor(grid: FlowGrid, edges: readonly [[number, number], [number, number]][]): Float64Array {
  const area = new Float64Array(grid.cols * grid.rows);
  for (const [from, to] of edges) {
    area[from[1] * grid.cols + from[0]] = 100;
    area[to[1] * grid.cols + to[0]] = 100;
  }
  return area;
}

const cellAt = (g: FlowGrid, c: number, r: number) => r * g.cols + c;

/** Two order-1 tributaries (A from the west, B from the north) meet at (2,2);
 * the trunk runs south and is joined at (2,1) by an order-1 tributary C. */
function junctionFixture() {
  const g = flatGrid(5, 5);
  const edges: [[number, number], [number, number]][] = [
    [[0, 2], [1, 2]], [[1, 2], [2, 2]],               // A
    [[2, 4], [2, 3]], [[2, 3], [2, 2]],               // B
    [[4, 1], [3, 1]], [[3, 1], [2, 1]],               // C
    [[2, 2], [2, 1]], [[2, 1], [2, 0]],               // trunk
  ];
  const routed = routedFrom(g, edges);
  const area = areaFor(g, edges);
  return { g, routed, area, net: buildFlowNetwork(g, routed, area, 50) };
}

function segmentStartingAt(net: ReturnType<typeof buildFlowNetwork>, cell: number) {
  const s = net.segments.find((seg) => seg.cells[0] === cell);
  if (!s) throw new Error(`no segment starts at cell ${cell}`);
  return s;
}

describe('buildFlowNetwork', () => {
  it('starts lines where contributing area reaches the threshold', () => {
    // A V-valley: the axis is column 10 and falls toward row 0, the southern edge.
    const cols = 21, rows = 21;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = Math.abs(c - 10) + 0.2 * r;
    const grid: FlowGrid = { z, valid: new Uint8Array(cols * rows).fill(1), cols, rows, cellMetresX: 1, cellMetresY: 1 };
    const routed = d8Flow(grid);
    const area = contributingAreaM2(flowAccumulation(grid, routed), grid, true)!;
    const net = buildFlowNetwork(grid, routed, area, 50);

    let firstOnAxis = -1;
    for (let r = rows - 1; r >= 0; r--) {
      if (net.onNetwork[r * cols + 10] === 1) { firstOnAxis = r; break; }
    }
    expect(firstOnAxis).toBeGreaterThan(0);
    const first = cellAt(grid, 10, firstOnAxis);
    const upstream = cellAt(grid, 10, firstOnAxis + 1);
    expect(area[first]).toBeGreaterThanOrEqual(50);
    expect(area[upstream]).toBeLessThan(50);
    expect(net.onNetwork[upstream]).toBe(0);
    // Every on-network cell meets the threshold, and every cell that meets it is on the network.
    for (let i = 0; i < area.length; i++) expect(net.onNetwork[i]).toBe(area[i] >= 50 ? 1 : 0);
    expect(net.thresholdM2).toBe(50);
    // One line down the axis, from the first cell to the outlet.
    const trunk = segmentStartingAt(net, first);
    expect(trunk.cells[trunk.cells.length - 1]).toBe(cellAt(grid, 10, 0));
    expect(trunk.order).toBe(1);
    expect(trunk.downstream).toBe(-1);
  });

  it('uses 2 500 m² when no threshold is given', () => {
    const g = flatGrid(3, 1);
    const routed = routedFrom(g, [[[0, 0], [1, 0]], [[1, 0], [2, 0]]]);
    const area = Float64Array.from([2499, 2500, 5000]);
    const net = buildFlowNetwork(g, routed, area);
    expect(net.thresholdM2).toBe(2500);
    expect(Array.from(net.onNetwork)).toEqual([0, 1, 1]);
  });

  it('splits segments at confluences and assigns Strahler order', () => {
    const { g, net } = junctionFixture();
    expect(net.segments).toHaveLength(5);

    const a = segmentStartingAt(net, cellAt(g, 0, 2));
    const b = segmentStartingAt(net, cellAt(g, 2, 4));
    const c = segmentStartingAt(net, cellAt(g, 4, 1));
    const upperTrunk = segmentStartingAt(net, cellAt(g, 2, 2));
    const lowerTrunk = segmentStartingAt(net, cellAt(g, 2, 1));

    expect(Array.from(a.cells)).toEqual([cellAt(g, 0, 2), cellAt(g, 1, 2)]);
    expect(Array.from(upperTrunk.cells)).toEqual([cellAt(g, 2, 2)]);
    expect(Array.from(lowerTrunk.cells)).toEqual([cellAt(g, 2, 1), cellAt(g, 2, 0)]);

    // Two order-1 lines make order 2 ...
    expect([a.order, b.order, c.order]).toEqual([1, 1, 1]);
    expect(upperTrunk.order).toBe(2);
    // ... and an order-1 line joining an order-2 line leaves order 2.
    expect(lowerTrunk.order).toBe(2);

    expect(a.downstream).toBe(upperTrunk.id);
    expect(b.downstream).toBe(upperTrunk.id);
    expect(upperTrunk.downstream).toBe(lowerTrunk.id);
    expect(c.downstream).toBe(lowerTrunk.id);
    expect(lowerTrunk.downstream).toBe(-1);
    net.segments.forEach((s, i) => expect(s.id).toBe(i));
  });

  it('raises the order when two lines of the same order meet', () => {
    // Two Y-shaped order-2 lines (west and east) meet at (4,1) and make order 3.
    const g = flatGrid(9, 6);
    const edges: [[number, number], [number, number]][] = [
      // west Y: two heads meet at (2,3)
      [[0, 5], [1, 4]], [[1, 4], [2, 3]],
      [[3, 5], [2, 4]], [[2, 4], [2, 3]],
      [[2, 3], [3, 2]],
      // east Y: two heads meet at (6,3)
      [[8, 5], [7, 4]], [[7, 4], [6, 3]],
      [[5, 5], [6, 4]], [[6, 4], [6, 3]],
      [[6, 3], [5, 2]],
      // the two order-2 lines meet at (4,1)
      [[3, 2], [4, 1]], [[5, 2], [4, 1]],
      [[4, 1], [4, 0]],
    ];
    const net = buildFlowNetwork(g, routedFrom(g, edges), areaFor(g, edges), 50);
    const last = net.segments.find((s) => s.downstream === -1)!;
    expect(last.order).toBe(3);
    expect(net.segments.filter((s) => s.order === 2)).toHaveLength(2);
  });

  it('measures segment length with diagonal steps as sqrt(dx²+dy²)', () => {
    // 2 m east-west, 1 m north-south: E = 2, N = 1, NE = sqrt(5).
    const g = flatGrid(4, 4, 2, 1);
    const routed = routedFrom(g, [
      [[0, 0], [1, 0]], // E
      [[1, 0], [1, 1]], // N
      [[1, 1], [2, 2]], // NE
    ]);
    const area = new Float64Array(16);
    for (const [c, r] of [[0, 0], [1, 0], [1, 1], [2, 2]]) area[cellAt(g, c, r)] = 100;
    const net = buildFlowNetwork(g, routed, area, 50);
    expect(net.segments).toHaveLength(1);
    expect(net.segments[0].lengthM).toBeCloseTo(2 + 1 + Math.sqrt(5), 12);
  });

  it('counts the step into a confluence in the segment that makes it', () => {
    const { g, net } = junctionFixture();
    const a = segmentStartingAt(net, cellAt(g, 0, 2));
    const upperTrunk = segmentStartingAt(net, cellAt(g, 2, 2));
    const lowerTrunk = segmentStartingAt(net, cellAt(g, 2, 1));
    expect(a.lengthM).toBe(2);          // (0,2)->(1,2)->(2,2)
    expect(upperTrunk.lengthM).toBe(1); // (2,2)->(2,1)
    expect(lowerTrunk.lengthM).toBe(1); // (2,1)->(2,0); the outlet has no further step
    // Eight drained cells make eight steps: the network length is complete.
    expect(net.segments.reduce((s, x) => s + x.lengthM, 0)).toBe(8);
  });

  it('keeps NoData cells off the network', () => {
    const g = flatGrid(3, 1);
    g.valid[1] = 0;
    const routed = routedFrom(g, [[[0, 0], [1, 0]]]);
    const net = buildFlowNetwork(g, routed, new Float64Array(3).fill(100), 50);
    expect(net.onNetwork[1]).toBe(0);
    expect(net.segments.every((s) => !Array.from(s.cells).includes(1))).toBe(true);
  });
});

describe('networkWithin', () => {
  it('clips to a mask and reports length per order', () => {
    const { g, net } = junctionFixture();
    // The A tributary and the whole trunk: A's cells (0,2),(1,2), then (2,2),(2,1),(2,0).
    const mask = new Uint8Array(25);
    for (const [c, r] of [[0, 2], [1, 2], [2, 2], [2, 1], [2, 0]]) mask[cellAt(g, c, r)] = 1;
    const w = networkWithin(net, mask);
    expect(w.maxOrder).toBe(2);
    expect(w.byOrder.get(1)).toEqual({ segments: 1, lengthM: 2 });
    expect(w.byOrder.get(2)).toEqual({ segments: 2, lengthM: 2 });
    expect(w.lengthM).toBe(4);
  });

  it('reports nothing for a mask that misses the network', () => {
    const { net } = junctionFixture();
    const w = networkWithin(net, new Uint8Array(25));
    expect(w).toEqual({ lengthM: 0, maxOrder: 0, byOrder: new Map() });
  });

  it('counts a partly covered segment by the steps that start inside the mask', () => {
    const { g, net } = junctionFixture();
    const mask = new Uint8Array(25);
    mask[cellAt(g, 2, 1)] = 1; // the first cell of the lower trunk only
    const w = networkWithin(net, mask);
    expect(w.lengthM).toBe(1);
    expect(w.maxOrder).toBe(2);
    expect(w.byOrder.get(2)).toEqual({ segments: 1, lengthM: 1 });
  });
});
