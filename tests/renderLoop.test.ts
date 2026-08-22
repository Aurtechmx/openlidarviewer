/**
 * The render loop's per-frame decisions.
 *
 * `runRenderFrame` previously lived inline in `Viewer._startLoop` and could
 * only be exercised through a real WebGL + requestAnimationFrame context, so
 * every scheduling decision it makes was covered by e2e alone. Extracting it
 * behind a structural {@link RenderLoopHost} makes those decisions directly
 * testable with a fake host: which paint path runs, the EDL snap-back on
 * settle, the streaming tick cadence, and the tool-overlay gating. The pure
 * predicates it composes (cameraIsMoving / edlActiveThisFrame /
 * shouldRunProbePick) are tested in their own modules; the parts that need a
 * real rAF (the loop scheduling itself) stay on the e2e suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { runRenderFrame, STREAMING_TICK_INTERVAL } from '../src/render/renderLoop';
import type { RenderLoopHost } from '../src/render/renderLoop';
import type { PointInfo } from '../src/render/pointInfo';

/** A fake host — permissive defaults (parked, EDL off, no tool), overridable per case. */
function makeHost(over: Partial<RenderLoopHost> = {}): RenderLoopHost {
  return {
    advanceFrameClock: () => 0.016,
    recordFrame: vi.fn(),
    updateNav: vi.fn(),
    maintainOrbitCenter: vi.fn(),
    updateAdaptiveEdl: vi.fn(),
    shouldRenderFrame: () => true,
    isTweening: () => false,
    // Parked by default: frameNow() > 0, so cameraIsMoving is false.
    activityUntilMs: () => 0,
    edlEnabled: () => false,
    applyAdaptiveDpr: vi.fn(),
    noteRendered: vi.fn(),
    noteSkipped: vi.fn(),
    renderEdl: vi.fn(),
    renderScene: vi.fn(),
    edlPaintedAtRest: () => false,
    setEdlPaintedAtRest: vi.fn(),
    hasStreaming: () => false,
    pumpStreamingCommit: vi.fn(),
    advanceStreamingFrame: () => 1,
    tickStreaming: vi.fn(),
    toolMode: () => 'none',
    measureDragging: () => false,
    pointerMoved: () => false,
    clearPointerMoved: vi.fn(),
    pointerOnCanvas: () => true,
    pointerNdc: () => ({ x: 0.1, y: 0.2 }),
    pointerClient: () => ({ x: 100, y: 200 }),
    pickPoint: () => null,
    setMeasureCursor: vi.fn(),
    userInteracting: () => false,
    probePickStatic: () => null,
    probePickStreaming: () => null,
    updateProbe: vi.fn(),
    renderMeasureOverlay: vi.fn(),
    renderInspectOverlay: vi.fn(),
    renderAnnotateOverlay: vi.fn(),
    ...over,
  };
}

const MOVING = () => Number.POSITIVE_INFINITY; // activityUntilMs → now < it → moving

describe('runRenderFrame — CPU pipeline runs every frame', () => {
  it('advances the clock and drives nav/orbit/EDL even when the frame is skipped', () => {
    const host = makeHost({
      shouldRenderFrame: () => false,
      advanceFrameClock: () => 0.02,
    });
    runRenderFrame(host);

    expect(host.recordFrame).toHaveBeenCalledWith(0.02);
    expect(host.updateNav).toHaveBeenCalledWith(0.02);
    expect(host.maintainOrbitCenter).toHaveBeenCalledTimes(1);
    expect(host.updateAdaptiveEdl).toHaveBeenCalledTimes(1);
    // DPR is picked every frame with the frame's delta and the render decision.
    expect(host.applyAdaptiveDpr).toHaveBeenCalledWith(false, 0.02, expect.any(Number), false);
  });
});

describe('runRenderFrame — paint path', () => {
  it('renders through EDL when parked and EDL is enabled', () => {
    const host = makeHost({ edlEnabled: () => true, activityUntilMs: () => 0 });
    runRenderFrame(host);

    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.renderScene).not.toHaveBeenCalled();
    expect(host.noteRendered).toHaveBeenCalledTimes(1);
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
  });

  it('renders the scene directly while moving, even with EDL enabled', () => {
    const host = makeHost({ edlEnabled: () => true, activityUntilMs: MOVING });
    runRenderFrame(host);

    expect(host.renderScene).toHaveBeenCalledTimes(1);
    expect(host.renderEdl).not.toHaveBeenCalled();
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(false);
  });

  it('renders the scene directly when EDL is disabled', () => {
    const host = makeHost({ edlEnabled: () => false });
    runRenderFrame(host);

    expect(host.renderScene).toHaveBeenCalledTimes(1);
    expect(host.renderEdl).not.toHaveBeenCalled();
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(false);
  });
});

describe('runRenderFrame — idle throttle and EDL snap-back', () => {
  it('forces one EDL repaint when motion settles and the last paint had EDL off', () => {
    const host = makeHost({
      shouldRenderFrame: () => false, // idle this frame
      edlEnabled: () => true,
      activityUntilMs: () => 0, // parked
      edlPaintedAtRest: () => false, // last paint was EDL-off (was moving)
    });
    runRenderFrame(host);

    expect(host.noteRendered).toHaveBeenCalledTimes(1);
    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
    expect(host.noteSkipped).not.toHaveBeenCalled();
  });

  it('skips the frame once the EDL snap-back has already been painted', () => {
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      activityUntilMs: () => 0,
      edlPaintedAtRest: () => true, // already snapped back
    });
    runRenderFrame(host);

    expect(host.noteSkipped).toHaveBeenCalledTimes(1);
    expect(host.renderEdl).not.toHaveBeenCalled();
    expect(host.noteRendered).not.toHaveBeenCalled();
  });

  it('skips the frame outright when EDL is off and nothing needs painting', () => {
    const host = makeHost({ shouldRenderFrame: () => false, edlEnabled: () => false });
    runRenderFrame(host);

    expect(host.noteSkipped).toHaveBeenCalledTimes(1);
    expect(host.renderScene).not.toHaveBeenCalled();
    expect(host.renderEdl).not.toHaveBeenCalled();
  });
});

describe('runRenderFrame — streaming cadence', () => {
  it('does nothing streaming-related when no session is attached', () => {
    const host = makeHost({ hasStreaming: () => false });
    runRenderFrame(host);

    expect(host.pumpStreamingCommit).not.toHaveBeenCalled();
    expect(host.tickStreaming).not.toHaveBeenCalled();
  });

  it('pumps commits every frame but ticks the scheduler only on the interval', () => {
    // Drive the frame counter 1..2*interval and count scheduler ticks.
    let counter = 0;
    const host = makeHost({
      hasStreaming: () => true,
      advanceStreamingFrame: () => ++counter,
    });
    const frames = STREAMING_TICK_INTERVAL * 2;
    for (let i = 0; i < frames; i++) runRenderFrame(host);

    expect(host.pumpStreamingCommit).toHaveBeenCalledTimes(frames);
    // Ticks land exactly on multiples of the interval → twice across 2×.
    expect(host.tickStreaming).toHaveBeenCalledTimes(2);
  });

  it('ticks on the interval-th frame, not before', () => {
    let counter = 0;
    const host = makeHost({
      hasStreaming: () => true,
      advanceStreamingFrame: () => ++counter,
    });
    for (let i = 0; i < STREAMING_TICK_INTERVAL - 1; i++) runRenderFrame(host);
    expect(host.tickStreaming).not.toHaveBeenCalled();
    runRenderFrame(host); // the interval-th frame
    expect(host.tickStreaming).toHaveBeenCalledTimes(1);
  });
});

describe('runRenderFrame — measure cursor gating', () => {
  it('picks and sets the cursor when measuring, not dragging, pointer moved over canvas', () => {
    const host = makeHost({
      toolMode: () => 'measure',
      pointerMoved: () => true,
      pointerOnCanvas: () => true,
      pickPoint: () => ({ x: 1, y: 2, z: 3 }),
    });
    runRenderFrame(host);

    expect(host.clearPointerMoved).toHaveBeenCalledTimes(1);
    expect(host.setMeasureCursor).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('clears the cursor when the pointer is off-canvas (no pick)', () => {
    const pickPoint = vi.fn(() => ({ x: 1, y: 2, z: 3 }));
    const host = makeHost({
      toolMode: () => 'measure',
      pointerMoved: () => true,
      pointerOnCanvas: () => false,
      pickPoint,
    });
    runRenderFrame(host);

    expect(pickPoint).not.toHaveBeenCalled();
    expect(host.setMeasureCursor).toHaveBeenCalledWith(null);
  });

  it('does nothing while a measurement drag is in progress', () => {
    const host = makeHost({
      toolMode: () => 'measure',
      measureDragging: () => true,
      pointerMoved: () => true,
    });
    runRenderFrame(host);

    expect(host.clearPointerMoved).not.toHaveBeenCalled();
    expect(host.setMeasureCursor).not.toHaveBeenCalled();
  });

  it('does nothing when the pointer has not moved', () => {
    const host = makeHost({ toolMode: () => 'measure', pointerMoved: () => false });
    runRenderFrame(host);

    expect(host.setMeasureCursor).not.toHaveBeenCalled();
  });
});

describe('runRenderFrame — live probe gating', () => {
  const staticInfo = { layer: 'static' } as unknown as PointInfo;
  const streamInfo = { layer: 'stream' } as unknown as PointInfo;

  it('reads the static pick and pushes it, skipping the streaming fallback', () => {
    const host = makeHost({
      toolMode: () => 'probe',
      pointerMoved: () => true,
      pointerOnCanvas: () => true,
      probePickStatic: () => staticInfo,
      probePickStreaming: vi.fn(() => streamInfo),
    });
    runRenderFrame(host);

    expect(host.clearPointerMoved).toHaveBeenCalledTimes(1);
    expect(host.probePickStreaming).not.toHaveBeenCalled();
    expect(host.updateProbe).toHaveBeenCalledWith(staticInfo, 100, 200);
  });

  it('falls back to the streaming pick when the static pick misses', () => {
    const host = makeHost({
      toolMode: () => 'probe',
      pointerMoved: () => true,
      pointerOnCanvas: () => true,
      probePickStatic: () => null,
      probePickStreaming: () => streamInfo,
    });
    runRenderFrame(host);

    expect(host.updateProbe).toHaveBeenCalledWith(streamInfo, 100, 200);
  });

  it('pushes a null readout when the pointer is off-canvas', () => {
    const host = makeHost({
      toolMode: () => 'probe',
      pointerMoved: () => true,
      pointerOnCanvas: () => false,
    });
    runRenderFrame(host);

    expect(host.updateProbe).toHaveBeenCalledWith(null, 100, 200);
  });

  it('does not pick or consume the pointer while the user is driving the camera', () => {
    const probePickStatic = vi.fn(() => staticInfo);
    const host = makeHost({
      toolMode: () => 'probe',
      pointerMoved: () => true,
      userInteracting: () => true,
      probePickStatic,
    });
    runRenderFrame(host);

    expect(probePickStatic).not.toHaveBeenCalled();
    expect(host.updateProbe).not.toHaveBeenCalled();
    expect(host.clearPointerMoved).not.toHaveBeenCalled();
  });
});

describe('runRenderFrame — overlay re-projection gating', () => {
  it('re-projects the tool overlays on rendered frames', () => {
    const host = makeHost({ shouldRenderFrame: () => true });
    runRenderFrame(host);

    expect(host.renderMeasureOverlay).toHaveBeenCalledTimes(1);
    expect(host.renderInspectOverlay).toHaveBeenCalledTimes(1);
    expect(host.renderAnnotateOverlay).toHaveBeenCalledTimes(1);
  });

  it('skips overlay re-projection on idle frames', () => {
    const host = makeHost({ shouldRenderFrame: () => false, edlEnabled: () => false });
    runRenderFrame(host);

    expect(host.renderMeasureOverlay).not.toHaveBeenCalled();
    expect(host.renderInspectOverlay).not.toHaveBeenCalled();
    expect(host.renderAnnotateOverlay).not.toHaveBeenCalled();
  });
});
