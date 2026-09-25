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
import { noteDrawn } from './drawSignal';
import type { PointInfo } from './pointInfo';
import type { ToolMode } from './Viewer';

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
  maintainOrbitCenter(dtSec: number): void;
  /** Modulate EDL strength from camera-to-target distance. */
  updateAdaptiveEdl(): void;

  /** Should the GPU `render()` run this frame? (idle-render throttle). */
  shouldRenderFrame(): boolean;
  /** Is a camera tween animating this frame? */
  isTweening(): boolean;
  /** The render-activity holdover deadline (ms), for the motion signal. */
  activityUntilMs(): number;
  /** The camera-motion deadline — hover and scene edits do not extend it. */
  cameraActivityUntilMs(): number;
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
  /**
   * Where the accumulation sweep is, or `none` when nothing is accumulating.
   *
   * The at-rest EDL repaint waits for it. Parking is the first frame of a
   * sweep, so shading there would light an image one phase complete and never
   * light it again: the flag the repaint sets says the at-rest paint is done.
   * The viewer would be left looking at a quarter of the scan with depth cues
   * drawn over it, which reads as a finished picture.
   *
   * `converged` and `none` behave alike, which is the point rather than a
   * shortcut: with accumulation off a sweep never starts, so it is never part
   * way through and the repaint happens exactly when it did before.
   */
  sweepState(): 'none' | 'converging' | 'converged';
  /** Record whether this frame's at-rest paint used EDL. */
  setEdlPaintedAtRest(value: boolean): void;
  /**
   * A frame drew: let the camera-mirroring HUD elements read it back.
   *
   * The view cube used to poll the heading on an animation frame of its own.
   * A heading cannot change without a frame, so the poll was a second loop
   * asking a question only this one can answer.
   */
  notifyFrameDrawn(): void;

  /** Is a streaming (COPC/EPT) session attached? */
  hasStreaming(): boolean;
  /** Drain metered streaming commits (no-op in immediate mode). */
  pumpStreamingCommit(): void;
  /**
   * Advance any node fade that is part way through.
   *
   * Fades drove an animation frame of their own, which competed with this
   * loop and kept running when it did not. Stepped here, they advance on the
   * loop's clock and stop when it does.
   */
  stepStreamingFades(): void;
  /** Run the paced streaming scheduler tick. */
  tickStreaming(): void;
  /**
   * Whether the scheduler is due at this time, recording the tick if so.
   *
   * The pacing policy is `schedulerCadence`; the Viewer applies it because it
   * owns both the last-tick time and the refinement phase the band comes from.
   */
  streamingTickDue(nowMs: number): boolean;
  /**
   * Update the streamed draw frustum from the camera about to be rendered.
   *
   * Every frame, before the draw. The scheduler tick runs at a sixth of this
   * and would lag the camera; culling from it would hide a node the viewer is
   * already looking at.
   */
  cullStreamingToFrustum(): void;

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
  host.maintainOrbitCenter(delta);
  // Adaptive EDL strength — cheap, runs every frame.
  host.updateAdaptiveEdl();

  // Idle-render throttle — when the scene is quiet we render only every Nth
  // frame. The CPU path above still runs every iteration; only the GPU
  // `render()` is gated.
  const rendered = host.shouldRenderFrame();
  const nowMs = frameNow();
  // Suspend EDL while the camera moves: its full-screen post-process is the
  // dominant per-frame cost during orbit/pan/fly. This reads the CAMERA
  // deadline, not the render one: pointer moves, colour-mode switches and
  // resizes all ask the loop to keep drawing, and reading that as motion
  // dropped EDL and the pixel ratio over a scene that never moved.
  const moving = cameraIsMoving(host.isTweening(), nowMs, host.cameraActivityUntilMs());
  const wantEdl = edlActiveThisFrame(host.edlEnabled(), moving);
  // Pick this frame's DPR before rendering so the render uses it.
  host.applyAdaptiveDpr(moving, delta, nowMs, rendered);

  // Streamed draw culling, before the draw and at its cadence. A node outside
  // the frustum keeps its mesh, its decoded chunk and its cache slot; only the
  // submission is skipped, so turning back costs a draw rather than a stream.
  if (rendered && host.hasStreaming()) host.cullStreamingToFrustum();

  if (rendered) {
    host.noteRendered();
    // EDL when parked → post-processing pipeline; moving or EDL off → direct.
    if (wantEdl) host.renderEdl();
    else host.renderScene();
    host.setEdlPaintedAtRest(wantEdl);
    noteDrawn();
  } else if (wantEdl && !host.edlPaintedAtRest() && host.sweepState() !== 'converging') {
    // Motion just settled and the last paint had EDL off — force one EDL
    // repaint so the depth cue snaps back, then resume idle throttling. A
    // sweep that is still building defers it: the shading belongs after the
    // last phase has merged, not over a quarter of one.
    host.noteRendered();
    host.renderEdl();
    host.setEdlPaintedAtRest(true);
    noteDrawn();
  } else {
    host.noteSkipped();
  }

  // The scheduler runs on elapsed time, never on a frame count. It was every
  // sixth frame, which is 100 ms at 60 Hz and 42 ms at 144 Hz, so it ran
  // nearly two and a half times as often on a faster panel and loaded
  // differently on the same scan; `schedulerCadence` holds the policy. The
  // commit pump and the fade step run every iteration regardless.
  if (host.hasStreaming()) {
    host.pumpStreamingCommit();
    // Every iteration, drawn or not: a fade that only advanced on drawn
    // frames would stall behind the idle throttle part way through.
    host.stepStreamingFades();
    if (host.streamingTickDue(nowMs)) host.tickStreaming();
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
    host.notifyFrameDrawn();
  }
}
