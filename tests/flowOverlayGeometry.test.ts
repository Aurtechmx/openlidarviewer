/**
 * flowOverlayGeometry.test.ts — the pure buffers the 3D flow overlay uploads.
 *
 * Four things are checked: the frame placement (a cell lands at the DTM's
 * own world position, rotated for a Y-up scene exactly as contours are),
 * NoData handling (skipped, never drawn as a zero elevation), the drainage
 * network contract (only channel cells, traced into lines that meet at
 * confluences, smoothed with their ends kept, width-scaled ribbons in the
 * water ramp, draped and lifted off the terrain, within a vertex budget,
 * deterministic), and — the §17
 * proof this feature must carry — that building every overlay's buffers from
 * a real run's arrays never mutates them: `flowFieldDigest` over the SAME
 * `FlowPulseResult` is identical before and after.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFlowAccumulationBuffers,
  buildFlowCatchmentBuffers,
  buildFlowPathBuffers,
  flowNetworkLines,
  flowOverlayFrame,
  flowRibbonShades,
  logScale,
  traceFlowNetwork,
  CATCHMENT_RGB,
  FLOW_CASING_EXTRA_CELLS,
  FLOW_CASING_RGB,
  FLOW_LINE_STRIDE,
  FLOW_NETWORK_LIFT_CELLS,
  FLOW_CHANNEL_THRESHOLD,
  FLOW_RIBBON_CORE_LIFT,
  FLOW_RIBBON_EDGE_SHADE,
  channelStrength,
  ribbonWidthCells,
  waterRampColor,
} from '../src/render/flowOverlayGeometry';
import { CELL_NODATA } from '../src/simulation/flowPulse/flowTypes';
import { flowFieldDigest } from '../src/simulation/flowPulse/flowFieldDigest';
import { FLOW_PULSE_DEFAULTS, runFlowPulse } from '../src/simulation/flowPulse/flowPulseRunner';
import { catchmentClick, traceClick } from '../src/simulation/flowPulse/flowClickGuard';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import {
  FLOW_PROJECTED_SCALE as projected,
  FLOW_TEST_IDENTITY as identity,
  flowDtmOf,
} from './helpers/flowFixtures';

// This suite's cell size and origin are deliberately non-trivial (unlike the
// shared fixture's 1 / (0, 0) default), to prove the frame placement reads
// the DTM's own values rather than an assumed unit grid.
function dtmOf(rows: readonly (readonly (number | null)[])[]): DtmGrid {
  return flowDtmOf(rows, { cellSizeM: 2, originH1: 100, originH2: 200 });
}

describe('flowOverlayFrame', () => {
  it('defaults to the survey (z-up) frame with no northing negation', () => {
    const f = flowOverlayFrame(null, 100, 200, 2);
    expect(f.verticalAxis).toBe('z');
    expect(f.negateNorthing).toBe(false);
  });

  it('negates northing only for a Y-up scene', () => {
    const f = flowOverlayFrame('y', 100, 200, 2);
    expect(f.verticalAxis).toBe('y');
    expect(f.negateNorthing).toBe(true);
  });
});

describe('logScale', () => {
  it('is 0 for a non-positive value or an empty maximum', () => {
    expect(logScale(0, 100)).toBe(0);
    expect(logScale(-5, 100)).toBe(0);
    expect(logScale(5, 0)).toBe(0);
  });

  it('is 1 at the maximum, and grows sub-linearly below it', () => {
    expect(logScale(100, 100)).toBe(1);
    const quarter = logScale(25, 100);
    expect(quarter).toBeGreaterThan(0.25); // log-scaled, not linear
    expect(quarter).toBeLessThan(1);
  });
});

/** A 2x2 slope: (0,0)=4 → (1,0)=2 (outlet); row 1 all NoData. */
function slope(): ReturnType<typeof runFlowPulse> {
  const dtm = dtmOf([[4, 2], [null, null]]);
  return runFlowPulse(dtm, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
}

// Slope fixture: upstream counts 1 (cell 0) and 2 (cell 1), max 2, so both
// are channel cells and form one line, cell 0 to the outlet at cell 1. It is
// straight, so smoothing leaves two points: two rows of 5 vertices (casing
// left/right, line left/centre/right) and a round cap at each end.
const ROW = 5;
const t0 = logScale(1, 2);
const s0 = channelStrength(t0);
const hw0 = ribbonWidthCells(t0) / 2;

/** Vertex `v`'s (column, row, elevation) back in grid terms, for a Z-up frame. */
function gridOf(verts: Float32Array, v: number, frame: { originH1: number; originH2: number; cellSizeM: number }): [number, number, number] {
  return [
    (verts[v * 3]! - frame.originH1) / frame.cellSizeM,
    (verts[v * 3 + 1]! - frame.originH2) / frame.cellSizeM,
    verts[v * 3 + 2]!,
  ];
}

/**
 * A rolling 64x64 surface with a winding valley: enough relief for a
 * branching network with confluences. `hole` cuts a disc of NoData into it.
 */
function rolling(hole = false): Extract<ReturnType<typeof runFlowPulse>, { ok: true }> {
  const N = 64;
  const waves = [
    [0.21, 0.83, 0.55, 1.9], [0.37, -0.64, 0.77, 1.1], [0.52, 0.31, -0.95, 0.7],
    [0.83, -0.9, -0.42, 0.45], [1.21, 0.12, 0.99, 0.3], [1.77, -0.58, 0.81, 0.18],
  ] as const;
  const rows: (number | null)[][] = [];
  for (let r = 0; r < N; r++) {
    const row: (number | null)[] = [];
    for (let c = 0; c < N; c++) {
      if (hole && (c - 22) ** 2 + (r - 38) ** 2 < 25) { row.push(null); continue; }
      const yc = 32 + 9 * Math.sin(c / 8);
      let h = 100 - 0.12 * c - 3 * Math.exp(-((r - yc) ** 2) / 50) + 0.03 * Math.abs(r - yc);
      for (const [f, cx, cy, a] of waves) h += a * Math.sin(f * (c * cx + r * cy));
      row.push(h);
    }
    rows.push(row);
  }
  const result = runFlowPulse(dtmOf(rows), projected, { ...FLOW_PULSE_DEFAULTS }, identity);
  if (!result.ok) throw new Error('fixture must run');
  return result;
}

/** Shortest distance from (c, r) to the polyline through `points`. */
function distanceToLine(points: Float64Array, c: number, r: number): number {
  let best = Infinity;
  for (let o = 0; o + FLOW_LINE_STRIDE < points.length; o += FLOW_LINE_STRIDE) {
    const ac = points[o]!, ar = points[o + 1]!;
    const dc = points[o + FLOW_LINE_STRIDE]! - ac, dr = points[o + FLOW_LINE_STRIDE + 1]! - ar;
    const len2 = dc * dc + dr * dr;
    const t = len2 > 0 ? Math.min(Math.max(((c - ac) * dc + (r - ar) * dr) / len2, 0), 1) : 0;
    best = Math.min(best, Math.hypot(c - ac - t * dc, r - ar - t * dr));
  }
  return points.length === FLOW_LINE_STRIDE ? Math.hypot(c - points[0]!, r - points[1]!) : best;
}

describe('buildFlowAccumulationBuffers — placement and NoData', () => {

  it('places a Z-up cell at originH + index·cellSize, lifted off the terrain on Z', () => {
    const result = slope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = flowOverlayFrame('z', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // 2 channel cells ((0,0) and (1,0)); the two NoData cells are skipped.
    expect(buffers.cellsDrawn).toBe(2);
    // Two rows plus two caps of 3 new casing and 3 new line vertices each.
    expect(buffers.verts.length / 3).toBe(2 * ROW + 2 * 6);
    // Vertex 3: the line centre at cell (0,0), draped at its elevation plus the lift.
    expect(buffers.verts[9]).toBeCloseTo(100); // x
    expect(buffers.verts[10]).toBeCloseTo(200); // y (north, un-negated)
    expect(buffers.verts[11]).toBeCloseTo(4 + FLOW_NETWORK_LIFT_CELLS * 2); // z = elevation + lift
    // Vertex 0: the casing's left edge there, half the casing width across the line.
    expect(buffers.verts[0]).toBeCloseTo(100);
    expect(buffers.verts[1]).toBeCloseTo(200 + (hw0 + FLOW_CASING_EXTRA_CELLS) * 2);
  });

  it('rotates into a Y-up scene: elevation on Y, northing negated', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('y', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    expect(buffers.verts[9]).toBeCloseTo(100); // x unchanged
    expect(buffers.verts[10]).toBeCloseTo(4 + FLOW_NETWORK_LIFT_CELLS * 2); // elevation now on Y
    expect(buffers.verts[11]).toBeCloseTo(-200); // northing negated
    const z = flowOverlayFrame('z', 100, 200, 2);
    const zb = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, z);
    for (let v = 0; v < zb.verts.length; v += 3) {
      expect(buffers.verts[v]).toBeCloseTo(zb.verts[v]!);
      expect(buffers.verts[v + 1]).toBeCloseTo(zb.verts[v + 2]!);
      expect(buffers.verts[v + 2]).toBeCloseTo(-zb.verts[v + 1]!);
    }
    expect(Array.from(buffers.index!)).toEqual(Array.from(zb.index!));
  });

  it('never drapes over a NoData cell: no zero elevation, no vertex over the empty row', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // Every drawn elevation lies between the two measured cells' (4 and 2)
    // plus the lift, never at the 0 the NoData row carries in the raw `z`.
    for (let v = 0; v < buffers.verts.length / 3; v++) {
      const [col, row, z] = gridOf(buffers.verts, v, frame);
      expect(z).toBeGreaterThanOrEqual(2 + FLOW_NETWORK_LIFT_CELLS - 1e-5);
      expect(z).toBeLessThanOrEqual(4 + FLOW_NETWORK_LIFT_CELLS + 1e-5);
      // The cell under every vertex is row 0, the measured one, and on the grid.
      expect(Math.round(row) === 0).toBe(true);
      expect(Math.round(col)).toBeGreaterThanOrEqual(0);
      expect(Math.round(col)).toBeLessThanOrEqual(1);
    }
  });
});

describe('buildFlowAccumulationBuffers — drainage network', () => {
  it('draws a ribbon as wide as the scaled value, shaded along the water ramp', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    const v = buffers.verts, col = buffers.colors;
    // Row 0, line left (2) and right (4): the width at the head cell.
    expect(Math.hypot(v[6]! - v[12]!, v[7]! - v[13]!)).toBeCloseTo(2 * hw0, 6);
    // Row 1, line centre (vertex 8) sits on the outlet cell's centre.
    expect(v[24]).toBeCloseTo(1);
    expect(v[25]).toBeCloseTo(0);
    // Colours: casing dark; the line's edges a step down the ramp, its centre a step up.
    expect(col[0]).toBeCloseTo(FLOW_CASING_RGB[0] / 255);
    const { edge, core } = flowRibbonShades(s0);
    expect(edge).toEqual(waterRampColor(s0 - FLOW_RIBBON_EDGE_SHADE));
    expect(core).toEqual(waterRampColor(s0 + FLOW_RIBBON_CORE_LIFT));
    for (let d = 0; d < 3; d++) {
      expect(col[6 + d]).toBeCloseTo(edge[d]! / 255, 6);
      expect(col[9 + d]).toBeCloseTo(core[d]! / 255, 6);
      expect(col[12 + d]).toBeCloseTo(edge[d]! / 255, 6);
    }
    // The trunk end (strength 1) has a near-white centre, brighter than the head's.
    const trunk = waterRampColor(1);
    expect(col[24]).toBeCloseTo(trunk[0] / 255, 6);
    expect(col[25]).toBeCloseTo(trunk[1] / 255, 6);
    expect(trunk[0]).toBeGreaterThan(core[0]!);
  });

  it('indexes triangles over shared vertices, every casing triangle before every line triangle', () => {
    const result = rolling();
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, flowOverlayFrame('z', 0, 0, 1));
    const index = buffers.index!;
    const vertices = buffers.verts.length / 3;
    expect(buffers.colors.length).toBe(buffers.verts.length);
    expect(index.length % 3).toBe(0);
    let seenLine = false;
    for (let k = 0; k < index.length; k += 3) {
      for (let d = 0; d < 3; d++) expect(index[k + d]).toBeLessThan(vertices);
      const casing = [0, 1, 2].every((d) => Math.abs(buffers.colors[index[k + d]! * 3]! - FLOW_CASING_RGB[0] / 255) < 1e-6
        && Math.abs(buffers.colors[index[k + d]! * 3 + 2]! - FLOW_CASING_RGB[2] / 255) < 1e-6);
      if (!casing) seenLine = true;
      else expect(seenLine).toBe(false);
    }
    expect(seenLine).toBe(true);
  });

  it('draws nothing below the channel threshold', () => {
    // A 6x1 strip falling east: upstream counts rise 1..6 along it.
    const dtm = dtmOf([[6, 5, 4, 3, 2, 1]]);
    const result = runFlowPulse(dtm, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    const up = result.accumulation.upstreamCells;
    let max = 0;
    for (let i = 0; i < up.length; i++) if (result.routed.status[i] !== CELL_NODATA && up[i]! > max) max = up[i]!;
    const below: number[] = [];
    let channel = 0;
    for (let i = 0; i < up.length; i++) {
      if (logScale(up[i]!, max) < FLOW_CHANNEL_THRESHOLD) below.push(i);
      else channel++;
    }
    expect(below.length).toBeGreaterThan(0);
    expect(buffers.cellsDrawn).toBe(channel);
    // One straight line: a row at least every cell, and two caps.
    const rows = (buffers.verts.length / 3 - 2 * 6) / ROW;
    expect(Number.isInteger(rows)).toBe(true);
    expect(rows).toBeGreaterThanOrEqual(channel);
    expect(rows).toBeLessThanOrEqual(2 * channel);
    // No vertex reaches into a below-threshold cell's centre half.
    for (const i of below) {
      const cx = i % result.grid.cols;
      for (let v = 0; v < buffers.verts.length; v += 3) {
        expect(Math.abs(buffers.verts[v]! - cx)).toBeGreaterThan(0.25);
      }
    }
  });

  it('draws nothing at all when no cell reaches the threshold', () => {
    const grid = { z: Float32Array.from([1, 1]), valid: Uint8Array.from([1, 1]), cols: 2, rows: 1, cellMetresX: 1, cellMetresY: 1 };
    const routed = {
      receiver: Int32Array.from([-1, -1]), direction: new Int8Array(2).fill(-1), status: new Uint8Array(2),
      sinkCount: 0, flatCount: 0, outletCount: 0,
    };
    const acc = { upstreamCells: Uint32Array.from([0, 0]), drainedCells: 0, unresolvedCells: 0 };
    const buffers = buildFlowAccumulationBuffers(grid as never, routed as never, acc as never, flowOverlayFrame('z', 0, 0, 1));
    expect(buffers.cellsDrawn).toBe(0);
    expect(buffers.verts.length).toBe(0);
    expect(buffers.index!.length).toBe(0);
  });

  it('is deterministic: the same run gives the same buffers', () => {
    const result = rolling(true);
    const frame = flowOverlayFrame('z', 100, 200, 0.5);
    const a = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    const b = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    expect(Array.from(a.verts)).toEqual(Array.from(b.verts));
    expect(Array.from(a.colors)).toEqual(Array.from(b.colors));
    expect(Array.from(a.index!)).toEqual(Array.from(b.index!));
    expect(a.cellsDrawn).toBe(b.cellsDrawn);
  });

  it('keeps every vertex on the grid, over a cell that carries an elevation, draped near the cells around it', () => {
    const result = rolling(true);
    const { grid, routed } = result;
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(grid, routed, result.accumulation, frame);
    let holes = 0;
    for (let i = 0; i < grid.cols * grid.rows; i++) if (routed.status[i] === CELL_NODATA) holes++;
    expect(holes).toBeGreaterThan(0);
    for (let v = 0; v < buffers.verts.length / 3; v++) {
      const [c, r, z] = gridOf(buffers.verts, v, frame);
      const col = Math.round(c), row = Math.round(r);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(grid.cols);
      expect(row).toBeLessThan(grid.rows);
      expect(routed.status[row * grid.cols + col]).not.toBe(CELL_NODATA);
      // Its elevation comes from measured cells within two of it, plus the lift.
      let lo = Infinity, hi = -Infinity;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const cc = col + dc, rr = row + dr;
          if (cc < 0 || rr < 0 || cc >= grid.cols || rr >= grid.rows) continue;
          const i = rr * grid.cols + cc;
          if (routed.status[i] === CELL_NODATA) continue;
          lo = Math.min(lo, grid.z[i]!); hi = Math.max(hi, grid.z[i]!);
        }
      }
      expect(z - FLOW_NETWORK_LIFT_CELLS).toBeGreaterThanOrEqual(lo - 1e-3);
      expect(z - FLOW_NETWORK_LIFT_CELLS).toBeLessThanOrEqual(hi + 1e-3);
    }
  });

  it('stays within a vertex budget well under one quad pair per cell', () => {
    const result = rolling();
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, flowOverlayFrame('z', 0, 0, 1));
    expect(buffers.cellsDrawn).toBeGreaterThan(100);
    // The per-cell drawing this replaced used 24 vertices a channel cell.
    expect(buffers.verts.length / 3).toBeLessThanOrEqual(12 * buffers.cellsDrawn);
  });
});

describe('traceFlowNetwork / flowNetworkLines — lines through the channel cells', () => {
  it('puts every channel cell in exactly one stem, each stem following its D8 receivers', () => {
    const result = rolling(true);
    const { routed } = result;
    const network = traceFlowNetwork(result.grid, routed, result.accumulation);
    const channel = new Set<number>();
    for (const stem of network.stems) {
      for (const i of stem.cells) {
        expect(channel.has(i)).toBe(false);
        channel.add(i);
      }
    }
    expect(channel.size).toBe(network.channelCells);
    network.stems.forEach((stem, k) => {
      for (let p = 0; p + 1 < stem.cells.length; p++) expect(routed.receiver[stem.cells[p]!]).toBe(stem.cells[p + 1]);
      const last = stem.cells[stem.cells.length - 1]!;
      if (stem.parent >= 0) {
        expect(stem.parent).toBeLessThan(k); // parents come first
        expect(routed.receiver[last]).toBe(network.stems[stem.parent]!.cells[stem.joinAt]);
      } else {
        // An outlet: its receiver is not a channel cell.
        expect(channel.has(routed.receiver[last]!)).toBe(false);
      }
    });
    const buffers = buildFlowAccumulationBuffers(result.grid, routed, result.accumulation, flowOverlayFrame('z', 0, 0, 1));
    expect(buffers.cellsDrawn).toBe(network.channelCells);
  });

  it('carries a trunk on up its largest donor at a confluence', () => {
    const result = rolling();
    const up = result.accumulation.upstreamCells;
    const network = traceFlowNetwork(result.grid, result.routed, result.accumulation);
    const tributaries = network.stems.filter((s) => s.parent >= 0);
    expect(tributaries.length).toBeGreaterThan(0);
    for (const stem of tributaries) {
      const parent = network.stems[stem.parent]!;
      expect(stem.joinAt).toBeGreaterThan(0);
      const mainDonor = parent.cells[stem.joinAt - 1]!;
      expect(up[mainDonor]).toBeGreaterThanOrEqual(up[stem.cells[stem.cells.length - 1]!]!);
    }
  });

  it('keeps each line\'s ends: its head cell, and its outlet cell or a point on the line it joins', () => {
    const result = rolling(true);
    const { grid } = result;
    const network = traceFlowNetwork(grid, result.routed, result.accumulation);
    const lines = flowNetworkLines(grid, result.routed, result.accumulation, network);
    expect(lines).toHaveLength(network.stems.length);
    let joins = 0;
    lines.forEach((line, k) => {
      const stem = network.stems[k]!;
      const p = line.points;
      const head = stem.cells[0]!;
      expect(p[0]).toBe(head % grid.cols);
      expect(p[1]).toBe(Math.floor(head / grid.cols));
      const end = p.length - FLOW_LINE_STRIDE;
      if (stem.parent < 0) {
        const outlet = stem.cells[stem.cells.length - 1]!;
        expect(p[end]).toBe(outlet % grid.cols);
        expect(p[end + 1]).toBe(Math.floor(outlet / grid.cols));
      } else {
        // The tributary ends on its parent's smoothed line, so the two meet.
        expect(distanceToLine(lines[stem.parent]!.points, p[end]!, p[end + 1]!)).toBeLessThan(0.03);
        joins++;
      }
    });
    expect(joins).toBeGreaterThan(0);
  });

  it('smooths a D8 staircase: no bend sharper than the cell steps it replaces, strength tapering', () => {
    // A tributary widens into its trunk at its end, mostly under the trunk, so strength steps are checked on outlet lines.
    const result = rolling();
    const lines = flowNetworkLines(result.grid, result.routed, result.accumulation);
    let maxTurn = 0, maxStep = 0;
    for (const line of lines) {
      const p = line.points;
      for (let o = FLOW_LINE_STRIDE; o + FLOW_LINE_STRIDE < p.length; o += FLOW_LINE_STRIDE) {
        const a = Math.atan2(p[o + 1]! - p[o - FLOW_LINE_STRIDE + 1]!, p[o]! - p[o - FLOW_LINE_STRIDE]!);
        const b = Math.atan2(p[o + FLOW_LINE_STRIDE + 1]! - p[o + 1]!, p[o + FLOW_LINE_STRIDE]! - p[o]!);
        let turn = Math.abs(b - a);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        maxTurn = Math.max(maxTurn, turn);
        if (line.parent < 0) maxStep = Math.max(maxStep, Math.abs(p[o + 2]! - p[o - FLOW_LINE_STRIDE + 2]!));
        // Never more than a cell between points, so the line keeps meeting the terrain.
        expect(Math.hypot(p[o]! - p[o - FLOW_LINE_STRIDE]!, p[o + 1]! - p[o - FLOW_LINE_STRIDE + 1]!)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
    // A D8 path turns by 45 degrees or more at a step; the smoothed lines turn by far less per point.
    expect(maxTurn).toBeLessThan(Math.PI / 8);
    expect(maxStep).toBeLessThan(0.25);
  });
});

describe('buildFlowCatchmentBuffers', () => {
  it('draws only the masked cells, in the catchment colour', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const trace = catchmentClick(result, { col: 1, row: 0 }, false);
    if (!trace.ok) throw new Error('fixture catchment must resolve');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowCatchmentBuffers(result.grid, trace.mask, frame);
    expect(buffers.cellsDrawn).toBe(trace.cells);
    const [r, g, b] = CATCHMENT_RGB;
    expect(buffers.colors[0]).toBeCloseTo(r / 255);
    expect(buffers.colors[1]).toBeCloseTo(g / 255);
    expect(buffers.colors[2]).toBeCloseTo(b / 255);
  });
});

describe('buildFlowPathBuffers', () => {
  it('draws one segment per consecutive path pair', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const trace = traceClick(result, { col: 0, row: 0 }, false);
    if (!trace.ok) throw new Error('fixture trace must resolve');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowPathBuffers(result.grid, trace.path, frame);
    expect(buffers.segments).toBe(trace.path.length - 1);
    expect(buffers.verts.length).toBe(buffers.segments * 6);
  });

  it('draws nothing for a single-cell (already-a-sink) path', () => {
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowPathBuffers(
      { z: Float32Array.from([1]), valid: Uint8Array.from([1]), cols: 1, rows: 1, cellMetresX: 1, cellMetresY: 1 },
      Int32Array.from([0]),
      frame,
    );
    expect(buffers.segments).toBe(0);
    expect(buffers.verts.length).toBe(0);
  });
});

describe('§17 — drawing the overlay never touches the run it draws', () => {
  it('leaves the fieldDigest unchanged after building every overlay buffer', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const before = flowFieldDigest(result.grid, result.routed, result.accumulation, result.conditioned);

    const frame = flowOverlayFrame('z', 100, 200, 2);
    buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    const trace = traceClick(result, { col: 0, row: 0 }, false);
    if (trace.ok) buildFlowPathBuffers(result.grid, trace.path, frame);
    const catchment = catchmentClick(result, { col: 1, row: 0 }, false);
    if (catchment.ok) buildFlowCatchmentBuffers(result.grid, catchment.mask, frame);
    // "Toggling" the overlay is a visibility flip at the three.js layer
    // (see flowOverlay.test.ts); at this pure layer there is nothing to
    // toggle but the build call itself, repeated, which must be equally inert.
    buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);

    const after = flowFieldDigest(result.grid, result.routed, result.accumulation, result.conditioned);
    expect(after).toBe(before);
  });
});
