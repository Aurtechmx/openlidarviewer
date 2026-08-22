/**
 * renderLoop.ts — the per-frame body the Viewer's `_startLoop` drives.
 *
 * `runRenderFrame` is one iteration of the animation loop: advance the frame
 * clock and the CPU pipeline (nav integration, orbit-centre maintenance,
 * adaptive EDL), decide whether this frame renders (idle-render throttle),
 * paint through the EDL post-process or straight to the renderer, run the
 * streaming scheduler on its throttled cadence, and re-project the tool
 * overlays. The requestAnimationFrame scheduling itself stays in `Viewer`
 * (browser-only, e2e-covered); only the body moves here.
 *
 * It reads the live scene through a structural {@link RenderLoopHost} — a set
 * of accessor and command functions rather than the Viewer itself — the same
 * seam the export adapter, colour legend and snapshot pipeline use, so nothing
 * here imports `Viewer` at runtime. `Viewer` keeps a thin `_startLoop` that
 * builds the host from its own state and schedules the loop. The stateless
 * decisions (render-vs-skip, EDL snap-back, streaming cadence, tool gating) now
 * unit-test against a fake host without a real WebGL or rAF context; the pure
 * predicates they compose (`cameraIsMoving`, `edlActiveThisFrame`,
 * `shouldRunProbePick`) are tested in their own modules. Part of the v0.6
 * decomposition (see `docs/architecture/architecture-map.md`).
 */

import { cameraIsMoving, edlActiveThisFrame } from './edlMotionGate';
import { shouldRunProbePick } from './hoverPickGate';
import type { PointInfo } from './pointInfo';
import type { ToolMode } from './Viewer';

/**
 * Run the streaming view-dependent scheduler once every this-many frames
 * (~10 Hz at 60 fps), never every frame. The per-frame commit pump and frame
 * counter still advance every iteration; only the scheduler tick is throttled.
 */
export const STREAMING_TICK_INTERVAL = 6;

/**
 * What the per-frame loop reads from the live scene. Accessors are functions,
 * not captured values, so every frame sees the CURRENT Viewer state — the
 * property the inline loop had by reading `this` per iteration. Commands wrap
 * the side-effecting calls (render, note-rendered/skipped, streaming tick,
 * overlay re-projection) so the ordering here is the whole contract.
 */
export interface RenderLoopHost {
  /** Advance the frame clock and return the delta in seconds for this frame. */
  advanceFrameClock(): number;
  /** Record frame timing for the FPS/among-frame stats. */
  recordFrame(delta: number): void;
  /** Integrate the navigation controller (OrbitControls damping, tweens). */
  updateNav(delta: number): void;
  /** Soft-clamp + streaming bounds-refinement lerp for the orbit pivot. */
  maintainOrbitCenter(): void;
  /** Modulate EDL strength from camera-to-target distance. */
  updateAdaptiveEdl(): void;

  /** Should the GPU `render()` run this frame? (idle-render throttle). */
  shouldRenderFrame(): boolean;
  /** Is a camera tween animating this frame? */
  isTweening(): boolean;
  /** The render-activity holdover deadline (ms), for the motion signal. */
  activityUntilMs(): number;
  /** Is Eye-Dome Lighting enabled at all? */
  edlEnabled(): boolean;
  /** Pick this frame's device-pixel-ratio before the render uses it. */
  applyAdaptiveDpr(moving: boolean, delta: number, nowMs: number, rendered: boolean): void;

  /** Mark that this frame rendered (resets the idle-skip counter). */
  noteRendered(): void;
  /** Mark that this frame was skipped by the idle throttle. */
  noteSkipped(): void;
  /** Paint through the EDL post-processing pipeline. */
  renderEdl(): void;
  /** Paint the scene directly (zero post-processing). */
  renderScene(): void;
  /** Was the last at-rest paint drawn with EDL on? */
  edlPaintedAtRest(): boolean;
  /** Record whether this frame's at-rest paint used EDL. */
  setEdlPaintedAtRest(value: boolean): void;

  /** Is a streaming (COPC/EPT) session attached? */
  hasStreaming(): boolean;
  /** Drain metered streaming commits (no-op in immediate mode). */
  pumpStreamingCommit(): void;
  /** Advance the streaming frame counter and return its new value. */
  advanceStreamingFrame(): number;
  /** Run the throttled streaming scheduler tick. */
  tickStreaming(): void;

  /** The active tool mode. */
  toolMode(): ToolMode;
  /** Is a measurement drag in progress (suppresses the hover cursor)? */
  measureDragging(): boolean;
  /** Has the pointer moved since it was last consumed? */
  pointerMoved(): boolean;
  /** Consume the pointer-moved flag. */
  clearPointerMoved(): void;
  /** Is the pointer currently over the canvas? */
  pointerOnCanvas(): boolean;
  /** The pointer's normalised device coordinates. */
  pointerNdc(): { x: number; y: number };
  /** The pointer's client coordinates (for the probe readout placement). */
  pointerClient(): { x: number; y: number };
  /** Pick a world point under the given NDC for the live measure cursor. */
  pickPoint(ndcX: number, ndcY: number): { x: number; y: number; z: number } | null;
  /** Set (or clear) the live measurement cursor. */
  setMeasureCursor(point: [number, number, number] | null): void;

  /**
   * Is the user driving the camera? Covers an OrbitControls drag and every mode
   * OrbitControls does not report (walk, fly, the custom orbit and hand-pan
   * drags); the host folds those together.
   */
  userInteracting(): boolean;
  /** Detailed probe pick against the static clouds, as display info, or null. */
  probePickStatic(ndcX: number, ndcY: number): PointInfo | null;
  /** Detailed probe pick against resident streaming nodes, or null. */
  probePickStreaming(ndcX: number, ndcY: number): PointInfo | null;
  /** Push the probe readout for this frame. */
  updateProbe(info: PointInfo | null, clientX: number, clientY: number): void;

  /** Re-project the measurement overlay against the current camera. */
  renderMeasureOverlay(): void;
  /** Re-project the inspector overlay. */
  renderInspectOverlay(): void;
  /** Re-project the annotation markers. */
  renderAnnotateOverlay(): void;
}

/** The frame timestamp — `performance.now()` where available, else `Date.now()`. */
function frameNow(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

/**
 * One iteration of the render loop. The CPU pipeline (timer, nav,
 * orbit-centre, adaptive EDL) runs every call regardless of whether the GPU
 * frame renders, so damping integrates and streaming keeps cadence; only the
 * `render()` call and the overlay re-projection are gated on `rendered`.
 */
export function runRenderFrame(host: RenderLoopHost): void {
  const delta = host.advanceFrameClock();
  host.recordFrame(delta);
  host.updateNav(delta);
  // Orbit-pivot maintenance — cheap and bounded; runs every frame regardless
  // of EDL/render state.
  host.maintainOrbitCenter();
  // Adaptive EDL strength — cheap, runs every frame.
  host.updateAdaptiveEdl();

  // Idle-render throttle — when the scene is quiet we render only every Nth
  // frame. The CPU path above still runs every iteration; only the GPU
  // `render()` is gated.
  const rendered = host.shouldRenderFrame();
  const nowMs = frameNow();
  // Suspend EDL while the camera moves: its full-screen post-process is the
  // dominant per-frame cost during orbit/pan/fly. `moving` reuses the same
  // motion signal the frame-rate throttle uses, so the two never disagree.
  const moving = cameraIsMoving(host.isTweening(), nowMs, host.activityUntilMs());
  const wantEdl = edlActiveThisFrame(host.edlEnabled(), moving);
  // Pick this frame's DPR before rendering so the render uses it.
  host.applyAdaptiveDpr(moving, delta, nowMs, rendered);

  if (rendered) {
    host.noteRendered();
    // EDL when parked → post-processing pipeline; moving or EDL off → direct.
    if (wantEdl) host.renderEdl();
    else host.renderScene();
    host.setEdlPaintedAtRest(wantEdl);
  } else if (wantEdl && !host.edlPaintedAtRest()) {
    // Motion just settled and the last paint had EDL off — force one EDL
    // repaint so the depth cue snaps back, then resume idle throttling.
    host.noteRendered();
    host.renderEdl();
    host.setEdlPaintedAtRest(true);
  } else {
    host.noteSkipped();
  }

  // Streaming COPC — throttled scheduler tick (~10 Hz), never every frame. The
  // commit pump and frame counter advance every frame.
  if (host.hasStreaming()) {
    host.pumpStreamingCommit();
    if (host.advanceStreamingFrame() % STREAMING_TICK_INTERVAL === 0) {
      host.tickStreaming();
    }
  }

  // After render, camera matrices are current — project the tool overlays.
  if (host.toolMode() === 'measure' && !host.measureDragging() && host.pointerMoved()) {
    host.clearPointerMoved();
    const ndc = host.pointerNdc();
    const hit = host.pointerOnCanvas() ? host.pickPoint(ndc.x, ndc.y) : null;
    host.setMeasureCursor(hit ? [hit.x, hit.y, hit.z] : null);
  }

  // Live probe — at most one detailed pick per frame, only when the pointer
  // actually moved, and never while the user is driving the camera. The
  // pointer-moved flag is consumed here so the probe fires once as the drag
  // settles. `tweening: false` matches the inline loop (no separate tween flag).
  if (
    host.toolMode() === 'probe' &&
    host.pointerMoved() &&
    shouldRunProbePick({ userInteracting: host.userInteracting(), tweening: false })
  ) {
    host.clearPointerMoved();
    let info: PointInfo | null = null;
    if (host.pointerOnCanvas()) {
      const ndc = host.pointerNdc();
      // Static clouds first; fall back to resident streaming nodes only when
      // the static pick misses — the COPC live probe.
      info = host.probePickStatic(ndc.x, ndc.y);
      info ??= host.probePickStreaming(ndc.x, ndc.y);
    }
    const client = host.pointerClient();
    host.updateProbe(info, client.x, client.y);
  }

  // Re-project the 2D tool overlays only on frames we actually rendered
  // (camera/scene changed). Quiet idle frames skip this DOM work; the idle
  // heartbeat still renders periodically, keeping overlays fresh.
  if (rendered) {
    host.renderMeasureOverlay();
    host.renderInspectOverlay();
    host.renderAnnotateOverlay();
  }
}
