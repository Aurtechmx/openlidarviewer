/**
 * floorPlanWallGraph.test.ts
 *
 * The v0.4.6 wall graph (wallGraph.ts): skeleton → {nodes, edges} → graph
 * re-extrusion. Synthetic truth grids, hand-computed:
 *
 *   - T / L / + junction topologies: junction & endpoint node counts and
 *     edge counts as drawn on paper;
 *   - per-edge mean thickness: a 3-cell strip at 0.1 m cells measures
 *     halfThickness ≈ 0.2 m (chamfer centre distance 2 cells);
 *   - observed fraction: an edge half-backed by the raw mask reads ≈ 0.5;
 *   - re-extrusion: a clean strip reproduces its own thickness (no fattening,
 *     no recession) and junction corners CLOSE (no notch at the L);
 *   - loops: a closed wall ring with no junctions gets a synthetic loop node
 *     and one self-edge, and its extrusion still encloses (hole preserved);
 *   - snapChainToAxes: free ends settle on the run's mean line, fixed ends
 *     never move.
 */

import { describe, it, expect } from 'vitest';
import {
  buildWallGraph,
  extrudeWallGraph,
  snapChainToAxes,
} from '../src/terrain/space/floorplan/wallGraph';
import { normalizeWallThickness } from '../src/terrain/space/floorplan/centerline';
import type { OccupancyGrid } from '../src/terrain/space/floorplan/occupancyGrid';

/** Blank canvas painter: rows × cols, fill rectangles in cell coords. */
function blank(cols: number, rows: number): {
  mask: Uint8Array;
  box: (c0: number, r0: number, c1: number, r1: number) => void;
} {
  const mask = new Uint8Array(cols * rows);
  return {
    mask,
    box: (c0, r0, c1, r1) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
    },
  };
}

function toGrid(mask: Uint8Array, cols: number, rows: number, cellM = 0.1): OccupancyGrid {
  return { mask, cols, rows, cellX: cellM, cellY: cellM, originX: 0, originY: 0, threshold: 1 };
}

/** Pipeline-faithful graph build: normalise → skeleton → graph. */
function graphOf(grid: OccupancyGrid, raw: OccupancyGrid | null = null) {
  const norm = normalizeWallThickness(grid);
  return {
    norm,
    graph: buildWallGraph(norm.walls, norm.skeleton, { raw }),
  };
}

const junctions = (g: { nodes: ReadonlyArray<{ kind: string }> }) =>
  g.nodes.filter((n) => n.kind === 'junction').length;
const endpoints = (g: { nodes: ReadonlyArray<{ kind: string }> }) =>
  g.nodes.filter((n) => n.kind === 'endpoint').length;

describe('buildWallGraph — junction topology on truth grids', () => {
  it('T: one junction, three endpoints, three edges', () => {
    // 3-thick horizontal run + 3-thick stem meeting it mid-span.
    const { mask, box } = blank(41, 31);
    box(2, 14, 38, 16); // horizontal, rows 14–16
    box(19, 17, 21, 28); // stem upward
    const { graph } = graphOf(toGrid(mask, 41, 31));
    expect(junctions(graph)).toBe(1);
    expect(endpoints(graph)).toBe(3);
    expect(graph.edges.length).toBe(3);
  });

  it('+: one junction, four endpoints, four edges', () => {
    const { mask, box } = blank(41, 41);
    box(2, 19, 38, 21); // horizontal
    box(19, 2, 21, 38); // vertical
    const { graph } = graphOf(toGrid(mask, 41, 41));
    expect(junctions(graph)).toBe(1);
    expect(endpoints(graph)).toBe(4);
    expect(graph.edges.length).toBe(4);
  });

  it('L: two limb-tip endpoints connected through the corner', () => {
    const { mask, box } = blank(33, 31);
    box(2, 2, 30, 4); // horizontal limb
    box(28, 2, 30, 28); // vertical limb (sharing the corner block)
    const { graph } = graphOf(toGrid(mask, 33, 31));
    // Zhang-Suen may leave a tiny fork artifact at the corner of a fat L, so
    // the corner can read as 0 junctions (one clean edge) or 1 (a short
    // corner stub the prune spared). What the graph must NOT do: invent
    // junctions along the limbs or lose the limb tips.
    expect(junctions(graph)).toBeLessThanOrEqual(1);
    expect(endpoints(graph)).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    expect(graph.edges.length).toBeLessThanOrEqual(3);
    // The graph spans both limbs: total centerline length ≈ 2.8 + 2.6 m.
    const total = graph.edges.reduce((acc, e) => acc + e.lengthM, 0);
    expect(total).toBeGreaterThan(4);
  });

  it('a junction-free closed ring becomes a loop node + one self-edge', () => {
    // A 1-cell DIAMOND ring (|c−15| + |r−15| = 10): every cell has exactly
    // two (diagonal) neighbours, so the skeleton is a pure degree-2 cycle.
    // (A raster RECTANGLE is not junction-free: at each corner the two turn
    // cells touch diagonally and read degree 3 under 8-connectivity.)
    const cols = 31, rows = 31;
    const mask = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if (Math.abs(c - 15) + Math.abs(r - 15) === 10) mask[r * cols + c] = 1;
    const { graph } = graphOf(toGrid(mask, cols, rows));
    expect(graph.nodes.filter((n) => n.kind === 'loop').length).toBe(1);
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].a).toBe(graph.edges[0].b);
    // The loop path is closed: first and last points coincide (same cell).
    const p = graph.edges[0].path;
    expect(Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1])).toBeLessThan(0.2);
  });
});

describe('buildWallGraph — per-edge measurements', () => {
  it('a 3-cell strip measures halfThickness ≈ 0.2 m (centre chamfer = 2 cells)', () => {
    const { mask, box } = blank(40, 11);
    box(2, 4, 37, 6); // 3 thick at 0.1 m cells
    const { graph } = graphOf(toGrid(mask, 40, 11));
    expect(graph.edges.length).toBe(1);
    // Centre cells read chamfer 2 (0.2 m); the run ends pull the mean down a
    // touch, so gate a band around the hand value.
    expect(graph.edges[0].halfThicknessM).toBeGreaterThan(0.15);
    expect(graph.edges[0].halfThicknessM).toBeLessThanOrEqual(0.25);
  });

  it('observed fraction reads ≈ 0.5 when only half the run has raw returns', () => {
    const cols = 60, rows = 9;
    const { mask, box } = blank(cols, rows);
    box(2, 3, 57, 5);
    const grid = toGrid(mask, cols, rows);
    // Raw (pre-close) mask: only the LEFT half of the strip was ever observed.
    const rawHalf = blank(cols, rows);
    rawHalf.box(2, 3, 29, 5);
    const { graph } = graphOf(grid, toGrid(rawHalf.mask, cols, rows));
    expect(graph.edges.length).toBe(1);
    expect(graph.edges[0].observedFrac).toBeGreaterThan(0.35);
    expect(graph.edges[0].observedFrac).toBeLessThan(0.65);
    // Fully-observed control.
    const { graph: full } = graphOf(grid, grid);
    expect(full.edges[0].observedFrac).toBe(1);
  });
});

describe('extrudeWallGraph — thickness fidelity + corner closure', () => {
  const count = (m: Uint8Array): number => m.reduce((a, b) => a + b, 0);

  it('reproduces an odd-width strip exactly (3 cells in, 3 cells out)', () => {
    const cols = 40, rows = 11;
    const { mask, box } = blank(cols, rows);
    box(2, 4, 37, 6);
    const grid = toGrid(mask, cols, rows);
    const { norm, graph } = graphOf(grid);
    const ext = extrudeWallGraph(graph, norm.walls);
    // Interior columns (away from the eroded ends): exactly 3 painted cells,
    // on the same rows the input strip occupied.
    for (let c = 8; c <= 31; c++) {
      let t = 0;
      for (let r = 0; r < rows; r++) t += ext.mask[r * cols + c];
      expect(t).toBe(3);
      expect(ext.mask[4 * cols + c] && ext.mask[5 * cols + c] && ext.mask[6 * cols + c]).toBeTruthy();
    }
  });

  it('reproduces an EVEN-width strip via mass recentring (2 cells in, 2 out)', () => {
    const cols = 40, rows = 10;
    const { mask, box } = blank(cols, rows);
    box(2, 4, 37, 5); // 2 thick — the parity the integer skeleton loses
    const grid = toGrid(mask, cols, rows);
    const { norm, graph } = graphOf(grid);
    const ext = extrudeWallGraph(graph, norm.walls);
    for (let c = 8; c <= 31; c++) {
      let t = 0;
      for (let r = 0; r < rows; r++) t += ext.mask[r * cols + c];
      expect(t).toBe(2);
      expect(ext.mask[4 * cols + c] && ext.mask[5 * cols + c]).toBeTruthy();
    }
  });

  it('closes the corner at an L join (no notch in the corner block)', () => {
    const cols = 33, rows = 31;
    const { mask, box } = blank(cols, rows);
    box(2, 2, 30, 4); // horizontal limb (rows 2–4)
    box(28, 2, 30, 28); // vertical limb (cols 28–30)
    const grid = toGrid(mask, cols, rows);
    const { norm, graph } = graphOf(grid);
    const ext = extrudeWallGraph(graph, norm.walls);
    // The 3×3 corner block where the limbs meet stays solid.
    let corner = 0;
    for (let r = 2; r <= 4; r++) for (let c = 28; c <= 30; c++) corner += ext.mask[r * cols + c];
    expect(corner).toBeGreaterThanOrEqual(7);
    // And the extrusion stays the same order of mass as the input — the graph
    // redistributes wall, it does not invent area (≤ ~20% growth from joins).
    expect(count(ext.mask)).toBeLessThan(1.2 * count(grid.mask));
  });

  it('a loop extrusion still encloses (the hole survives)', () => {
    const cols = 30, rows = 30;
    const { mask, box } = blank(cols, rows);
    box(2, 2, 27, 3); box(2, 26, 27, 27); box(2, 2, 3, 27); box(26, 2, 27, 27);
    const grid = toGrid(mask, cols, rows);
    const { norm, graph } = graphOf(grid);
    const ext = extrudeWallGraph(graph, norm.walls);
    // Centre stays free, and a 4-connected flood from the centre never
    // reaches the grid border — the ring is watertight.
    const seen = new Uint8Array(cols * rows);
    const stack = [15 * cols + 15];
    expect(ext.mask[15 * cols + 15]).toBe(0);
    seen[15 * cols + 15] = 1;
    let leaked = false;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const r = (i / cols) | 0, c = i - r * cols;
      if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1) { leaked = true; break; }
      for (const j of [i - 1, i + 1, i - cols, i + cols]) {
        if (!seen[j] && !ext.mask[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    expect(leaked).toBe(false);
  });
});

describe('snapChainToAxes', () => {
  it('free ends settle the whole run on the mean line', () => {
    const out = snapChainToAxes([[0, 0], [5, 0.08], [10, 0]], 0, 7, false, false);
    // Segment means: 0.04 and 0.04 — every vertex lands on y = 0.04.
    for (const [, y] of out) expect(y).toBeCloseTo(0.04, 9);
    expect(out[0][0]).toBeCloseTo(0, 9);
    expect(out[out.length - 1][0]).toBeCloseTo(10, 9);
  });

  it('fixed ends never move (anchored junction behaviour)', () => {
    const out = snapChainToAxes([[0, 0], [5, 0.08], [10, 0]], 0, 7, true, true);
    expect(out[0][0]).toBe(0);
    expect(out[0][1]).toBe(0);
    expect(out[out.length - 1][0]).toBe(10);
    expect(out[out.length - 1][1]).toBe(0);
    // The interior vertex settles between the (end-pinned) segment lines.
    expect(Math.abs(out[1][1])).toBeLessThan(0.08);
  });

  it('leaves an off-axis (diagonal) chain untouched', () => {
    const diag: Array<readonly [number, number]> = [[0, 0], [3, 2.6], [6, 5.4]];
    const out = snapChainToAxes(diag, 0, 7, false, false);
    expect(out).toEqual(diag);
  });
});
