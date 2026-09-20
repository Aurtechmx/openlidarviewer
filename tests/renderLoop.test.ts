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
import { runRenderFrame } from '../src/render/renderLoop';
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
    cameraActivityUntilMs: () => 0,
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
    stepStreamingFades: vi.fn(),
    notifyFrameDrawn: vi.fn(),
    sweepState: () => 'none' as const,
    tickStreaming: vi.fn(),
    streamingTickDue: () => true,
    cullStreamingToFrustum: vi.fn(),
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

const MOVING = () => Number.POSITIVE_INFINITY; // cameraActivityUntilMs → now < it → moving

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
    const host = makeHost({ edlEnabled: () => true, cameraActivityUntilMs: () => 0 });
    runRenderFrame(host);

    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.renderScene).not.toHaveBeenCalled();
    expect(host.noteRendered).toHaveBeenCalledTimes(1);
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
  });

  it('renders the scene directly while moving, even with EDL enabled', () => {
    const host = makeHost({ edlEnabled: () => true, cameraActivityUntilMs: MOVING });
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
      cameraActivityUntilMs: () => 0, // parked
      edlPaintedAtRest: () => false, // last paint was EDL-off (was moving)
    });
    runRenderFrame(host);

    expect(host.noteRendered).toHaveBeenCalledTimes(1);
    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
    expect(host.noteSkipped).not.toHaveBeenCalled();
  });

  it('defers the repaint while an accumulation sweep is still building', () => {
    // Parking is the first frame of a sweep. Shading there lights an image one
    // phase complete and never lights it again, because the flag the repaint
    // sets says the at-rest paint is done: the viewer is left looking at a
    // quarter of the scan with depth cues drawn over it.
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      cameraActivityUntilMs: () => 0,
      edlPaintedAtRest: () => false,
      sweepState: () => 'converging' as const,
    });
    runRenderFrame(host);

    expect(host.renderEdl).not.toHaveBeenCalled();
    expect(host.setEdlPaintedAtRest).not.toHaveBeenCalled();
    expect(host.noteSkipped).toHaveBeenCalledTimes(1);
  });

  it('repaints once the sweep has converged', () => {
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      cameraActivityUntilMs: () => 0,
      edlPaintedAtRest: () => false,
      sweepState: () => 'converged' as const,
    });
    runRenderFrame(host);

    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
  });

  it('repaints as it always did when nothing is accumulating', () => {
    // A sweep that never starts is never part way through, so a viewer with
    // accumulation off sees exactly the behaviour that shipped.
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      cameraActivityUntilMs: () => 0,
      edlPaintedAtRest: () => false,
      sweepState: () => 'none' as const,
    });
    runRenderFrame(host);

    expect(host.renderEdl).toHaveBeenCalledTimes(1);
  });

  it('does not repaint mid-sweep even once the camera has been parked a while', () => {
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      cameraActivityUntilMs: () => 0,
      edlPaintedAtRest: () => false,
      sweepState: () => 'converging' as const,
    });
    for (let i = 0; i < 5; i++) runRenderFrame(host);
    expect(host.renderEdl).not.toHaveBeenCalled();
  });

  it('skips the frame once the EDL snap-back has already been painted', () => {
    const host = makeHost({
      shouldRenderFrame: () => false,
      edlEnabled: () => true,
      cameraActivityUntilMs: () => 0,
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

  it('pumps commits every frame but ticks the scheduler only when it is due', () => {
    // The cadence is now elapsed time, so the loop asks the host rather than
    // counting frames. Due on every third call here.
    let calls = 0;
    const host = makeHost({
      hasStreaming: () => true,
      streamingTickDue: () => (++calls % 3 === 0),
    });
    const frames = 9;
    for (let i = 0; i < frames; i++) runRenderFrame(host);

    expect(host.pumpStreamingCommit).toHaveBeenCalledTimes(frames);
    expect(host.tickStreaming).toHaveBeenCalledTimes(3);
    // Fades step on every iteration, not on the scheduler's cadence: a fade
    // that advanced at 10 Hz would be visible as a stutter.
    expect(host.stepStreamingFades).toHaveBeenCalledTimes(frames);
  });

  it('does not tick while the host says it is not due', () => {
    const host = makeHost({ hasStreaming: () => true, streamingTickDue: () => false });
    for (let i = 0; i < 20; i++) runRenderFrame(host);
    expect(host.pumpStreamingCommit).toHaveBeenCalledTimes(20);
    expect(host.tickStreaming).not.toHaveBeenCalled();
  });

  it('asks the host once per frame, so the cadence cannot double-count', () => {
    let asked = 0;
    const host = makeHost({
      hasStreaming: () => true,
      streamingTickDue: () => { asked += 1; return false; },
    });
    for (let i = 0; i < 5; i++) runRenderFrame(host);
    expect(asked).toBe(5);
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

describe('runRenderFrame — hover is not camera motion', () => {
  /**
   * A pointer move over a stationary cloud extends the RENDER deadline (the
   * loop must draw for the hover highlight) but not the CAMERA one. Reading
   * the render deadline as motion suspended EDL and dropped the pixel ratio
   * for the holdover, then restored both — the brightness pop on hover.
   */
  it('keeps EDL and the parked DPR while only the render deadline is live', () => {
    const host = makeHost({
      edlEnabled: () => true,
      activityUntilMs: () => Number.POSITIVE_INFINITY, // hover keeps drawing
      cameraActivityUntilMs: () => 0, // the camera never moved
    });
    runRenderFrame(host);

    expect(host.renderEdl).toHaveBeenCalledTimes(1);
    expect(host.renderScene).not.toHaveBeenCalled();
    expect(host.setEdlPaintedAtRest).toHaveBeenCalledWith(true);
    expect(host.applyAdaptiveDpr).toHaveBeenCalledWith(false, expect.any(Number), expect.any(Number), true);
  });
});
