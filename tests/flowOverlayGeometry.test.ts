/**
 * flowOverlayGeometry.test.ts — the pure buffers the 3D flow overlay uploads.
 *
 * Four things are checked: the frame placement (a cell lands at the DTM's
 * own world position, rotated for a Y-up scene exactly as contours are),
 * NoData handling (skipped, never drawn as a zero elevation), the drainage
 * network contract (only channel cells, width-scaled ribbons to the D8
 * receiver, water-ramp colours, lifted off the terrain), and — the §17
 * proof this feature must carry — that building every overlay's buffers from
 * a real run's arrays never mutates them: `flowFieldDigest` over the SAME
 * `FlowPulseResult` is identical before and after.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFlowAccumulationBuffers,
  buildFlowCatchmentBuffers,
  buildFlowPathBuffers,
  flowOverlayFrame,
  logScale,
  CATCHMENT_RGB,
  FLOW_CASING_EXTRA_CELLS,
  FLOW_CASING_RGB,
  FLOW_NETWORK_LIFT_CELLS,
  FLOW_CHANNEL_THRESHOLD,
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
// are channel cells; cell 0 links to cell 1, cell 1 is the outlet. Buffer
// order: casing joint 0, casing ribbon 0→1, casing joint 1, then the same
// three quads for the line pass. 18 floats per quad.
const QUAD = 18;
const t0 = logScale(1, 2);
const casingWidth0 = ribbonWidthCells(t0) + 2 * FLOW_CASING_EXTRA_CELLS;

describe('buildFlowAccumulationBuffers — placement and NoData', () => {

  it('places a Z-up cell at originH + index·cellSize, lifted elevation on Z', () => {
    const result = slope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = flowOverlayFrame('z', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // 2 channel cells ((0,0) and (1,0)); the two NoData cells are skipped.
    expect(buffers.cellsDrawn).toBe(2);
    // 2 passes x (2 joints + 1 ribbon) quads.
    expect(buffers.verts.length).toBe(6 * QUAD);
    // First vertex: the (-w/2, -w/2) corner of cell (0,0)'s casing joint.
    expect(buffers.verts[0]).toBeCloseTo(100 + (-0.5 * casingWidth0) * 2); // x
    expect(buffers.verts[1]).toBeCloseTo(200 + (-0.5 * casingWidth0) * 2); // y (north, un-negated)
    expect(buffers.verts[2]).toBeCloseTo(4 + FLOW_NETWORK_LIFT_CELLS * 2); // z = elevation + lift
  });

  it('rotates into a Y-up scene: elevation on Y, northing negated', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('y', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    expect(buffers.verts[0]).toBeCloseTo(100 + (-0.5 * casingWidth0) * 2); // x unchanged
    expect(buffers.verts[1]).toBeCloseTo(4 + FLOW_NETWORK_LIFT_CELLS * 2); // elevation now on Y
    expect(buffers.verts[2]).toBeCloseTo(-(200 + (-0.5 * casingWidth0) * 2)); // northing negated
    // The line-pass ribbon 0→1 ends at cell (1,0)'s centre, also negated.
    const z = flowOverlayFrame('z', 100, 200, 2);
    const zb = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, z);
    for (let v = 0; v < zb.verts.length; v += 3) {
      expect(buffers.verts[v]).toBeCloseTo(zb.verts[v]!);
      expect(buffers.verts[v + 1]).toBeCloseTo(zb.verts[v + 2]!);
      expect(buffers.verts[v + 2]).toBeCloseTo(-zb.verts[v + 1]!);
    }
  });

  it('skips NoData cells outright, not as a zero elevation', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // Every drawn elevation is 4 or 2 plus the lift — never the 0 the NoData
    // rows carry in the raw `z` array (NaN-free storage defaults an unread cell to 0).
    for (let i = 2; i < buffers.verts.length; i += 3) {
      expect([4 + FLOW_NETWORK_LIFT_CELLS, 2 + FLOW_NETWORK_LIFT_CELLS].some((e) => Math.abs(e - buffers.verts[i]!) < 1e-6)).toBe(true);
    }
  });
});

describe('buildFlowAccumulationBuffers — drainage network', () => {
  it('draws a ribbon to the D8 receiver as wide as the scaled value, in the water ramp', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, flowOverlayFrame('z', 0, 0, 1));
    // Line-pass ribbon 0→1 is quad 4. Its first two vertices are A ± n·w/2.
    const r = 4 * QUAD;
    const width = Math.hypot(buffers.verts[r]! - buffers.verts[r + 3]!, buffers.verts[r + 1]! - buffers.verts[r + 4]!);
    expect(width).toBeCloseTo(ribbonWidthCells(t0), 6);
    // Its far end sits at cell (1,0)'s centre: vertices 2 and 5 average to (1, 0).
    expect((buffers.verts[r + 6]! + buffers.verts[r + 15]!) / 2).toBeCloseTo(1);
    expect((buffers.verts[r + 7]! + buffers.verts[r + 16]!) / 2).toBeCloseTo(0);
    // Colours: casing first, then the ramp; the trunk (t = 1) is near white.
    expect(buffers.colors[0]).toBeCloseTo(FLOW_CASING_RGB[0] / 255);
    const rill = waterRampColor(channelStrength(t0));
    expect(buffers.colors[3 * QUAD]).toBeCloseTo(rill[0] / 255);
    expect(buffers.colors[3 * QUAD + 2]).toBeCloseTo(rill[2] / 255);
    const trunk = waterRampColor(1);
    expect(buffers.colors[5 * QUAD]).toBeCloseTo(trunk[0] / 255);
    expect(buffers.colors[5 * QUAD + 1]).toBeCloseTo(trunk[1] / 255);
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
    let channel = 0, links = 0;
    for (let i = 0; i < up.length; i++) {
      if (logScale(up[i]!, max) < FLOW_CHANNEL_THRESHOLD) { below.push(i); continue; }
      channel++;
      if (result.routed.receiver[i]! >= 0) links++;
    }
    expect(below.length).toBeGreaterThan(0);
    expect(buffers.cellsDrawn).toBe(channel);
    expect(buffers.verts.length).toBe(2 * (channel + links) * QUAD);
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
