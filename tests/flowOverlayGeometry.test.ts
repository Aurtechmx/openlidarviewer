/**
 * flowOverlayGeometry.test.ts — the pure buffers the 3D flow overlay uploads.
 *
 * Three things are checked: the frame placement (a cell lands at the DTM's
 * own world position, rotated for a Y-up scene exactly as contours are),
 * NoData handling (skipped, never drawn as a zero elevation), and — the §17
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
} from '../src/render/flowOverlayGeometry';
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

describe('buildFlowAccumulationBuffers — placement and NoData', () => {
  it('places a Z-up cell at originH + index·cellSize, elevation on Z', () => {
    const result = slope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const frame = flowOverlayFrame('z', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // 2 drawn cells ((0,0) and (1,0)); the two NoData cells are skipped.
    expect(buffers.cellsDrawn).toBe(2);
    // First triangle's first vertex is the (col-0.5,row-0.5) corner of cell (0,0).
    expect(buffers.verts[0]).toBeCloseTo(100 + (-0.5) * 2); // x
    expect(buffers.verts[1]).toBeCloseTo(200 + (-0.5) * 2); // y (north, un-negated)
    expect(buffers.verts[2]).toBeCloseTo(4); // z = elevation
  });

  it('rotates into a Y-up scene: elevation on Y, northing negated', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('y', 100, 200, 2);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    expect(buffers.verts[0]).toBeCloseTo(100 + (-0.5) * 2); // x unchanged
    expect(buffers.verts[1]).toBeCloseTo(4); // elevation now on Y
    expect(buffers.verts[2]).toBeCloseTo(-(200 + (-0.5) * 2)); // northing negated
  });

  it('skips NoData cells outright, not as a zero elevation', () => {
    const result = slope();
    if (!result.ok) throw new Error('fixture must run');
    const frame = flowOverlayFrame('z', 0, 0, 1);
    const buffers = buildFlowAccumulationBuffers(result.grid, result.routed, result.accumulation, frame);
    // Every drawn elevation is 4 or 2 — never the 0 the NoData rows carry in
    // the raw `z` array (NaN-free storage defaults an unread cell to 0).
    for (let i = 2; i < buffers.verts.length; i += 3) {
      expect([4, 2]).toContain(buffers.verts[i]);
    }
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
