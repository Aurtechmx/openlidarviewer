/**
 * renderActivityGate.ts — decides whether the render loop draws this frame.
 *
 * Lifted from `Viewer._shouldRenderFrame` plus its scattered activity
 * timestamp and heartbeat counter. The loop skips frames when nothing is
 * happening so the GPU idles, but must draw when a tween runs, when input is
 * recent, when streaming nodes are arriving, or on a periodic heartbeat that
 * keeps the scene fresh. That decision read `performance.now()` and the
 * scheduler, so it could only run inside a live loop.
 *
 * The gate takes the current time as an argument and a small "is streaming
 * busy" flag, so the whole decision is pure and tests in Node. The Viewer
 * keeps the loop, the clock reads, and the actual `render()` call, and tells
 * the gate whether the frame drew via `noteRendered` / `noteSkipped`.
 *
 * Behaviour is preserved exactly, including that `bump` assigns the deadline
 * unconditionally rather than taking a max. `performance.now()` is monotonic,
 * so successive bumps only ever increase; the unconditional write matches the
 * original and avoids implying a guard the loop does not rely on.
 */

/** How long after an input the loop keeps drawing at full rate. */
export const RENDER_HOLDOVER_MS = 350;

/** Idle frames between heartbeat renders when nothing else asks to draw. */
export const IDLE_HEARTBEAT_FRAMES = 6;

/** The per-frame inputs the decision needs beyond the clock. */
export interface RenderActivitySignals {
  /** A camera tween is in progress (intro, preset transition). */
  readonly tweening: boolean;
  /** The streaming scheduler has in-flight or queued node fetches. */
  readonly streamingBusy: boolean;
  /**
   * Decoded geometry is waiting to reach the GPU, or reached it on the frame
   * just gone and has not been painted yet.
   *
   * Distinct from {@link streamingBusy}, which is the FETCH side: the
   * scheduler's queue empties as soon as the last chunk decodes, while the
   * metered commit pump is still spending its per-frame budget uploading what
   * decoded. A tail of nodes therefore commits with nothing else asking for a
   * frame, and the pump runs AFTER the paint in the loop body, so the last
   * one lands on a scene that has already been drawn. Without this the gate
   * saw only the fetch side and could idle-throttle those frames, leaving
   * geometry on the GPU undrawn until the heartbeat came round.
   *
   * Driving a real COPC session, node-join to paint measured a 9-66 ms median
   * with and without this signal, in both commit modes, so the stall was
   * never caught happening — usually something else is asking for the frame
   * while the scheduler ticks. That is a weak result rather than an all-clear:
   * 34 node arrivals were observed in total, which bounds an occasional stall
   * no tighter than "under roughly one arrival in eleven". The gap is closed
   * by construction because measuring it away would take thousands of
   * samples, not because it was shown to be rare.
   */
  readonly commitWork: boolean;
}

/**
 * Did the camera's pose change since the last frame?
 *
 * Walk and fly modes take the camera away from OrbitControls (`controls.enabled
 * = false`) and drive position and orientation directly, so the 'change' event
 * that carries the orbit/pan/dolly motion signal never fires there. Comparing
 * the pose across frames catches that motion — and any other source — without
 * the Viewer having to enumerate them.
 *
 * The comparison is exact rather than epsilon-based: a pose that differs at all
 * is motion, and the effects this gates (EDL, pixel ratio) hold for the
 * holdover window afterwards, so a sub-pixel drift cannot flap them frame to
 * frame. The camera is read structurally, so this stays free of three.js.
 */
export interface CameraPose {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
}

/**
 * Does this navigation mode move the camera outside OrbitControls?
 *
 * Only walk and fly do: they set `controls.enabled = false` and write the
 * camera transform directly, so no 'change' event carries their motion and the
 * pose comparison is the only signal. Orbit and pan go through the controls,
 * where {@link DampingSettleGate} decides when the damping tail has fallen
 * below the perceptual threshold — and the pose comparison must not overrule
 * that, or the tail's sub-pixel float changes would hold the camera "moving"
 * for seconds after the view has visibly come to rest.
 */
export function poseDrivesCamera(mode: string): boolean {
  return mode === 'walk' || mode === 'fly';
}

export class CameraPoseWatch {
  private _last: readonly number[] | null = null;

  /**
   * Did the camera move under a mode that OrbitControls does not speak for?
   *
   * The pose is sampled on every call regardless of mode, so the baseline
   * stays current across a mode switch; the answer is withheld under orbit and
   * pan, where {@link poseDrivesCamera} explains why.
   */
  movedOutsideControls(camera: CameraPose, mode: string): boolean {
    const moved = this.moved(camera);
    return moved && poseDrivesCamera(mode);
  }

  /** Record this frame's pose and report whether it differs from the last. */
  moved(camera: CameraPose): boolean {
    const { position: p, quaternion: q } = camera;
    const pose = [p.x, p.y, p.z, q.x, q.y, q.z, q.w];
    const prev = this._last;
    this._last = pose;
    if (prev === null) return false;
    for (let i = 0; i < pose.length; i++) if (prev[i] !== pose[i]) return true;
    return false;
  }
}

export class RenderActivityGate {
  private _activityUntilMs = 0;
  // A SECOND deadline, extended only by input that actually moves the camera.
  // The render deadline above answers "keep drawing"; hovering a stationary
  // cloud, switching colour mode and resizing all answer yes to that. They are
  // not motion, and reading the render deadline as motion suspended EDL and
  // dropped the pixel ratio for 350 ms on a plain mouse move — a visible
  // brightness pop over a scene that never moved.
  private _cameraUntilMs = 0;
  // Starts armed so the very first loop iteration draws — otherwise the scene
  // would not appear until the first input.
  private _idleHeartbeat = IDLE_HEARTBEAT_FRAMES;

  /** The activity deadline, exposed for the shared moving-camera signal. */
  get activityUntilMs(): number {
    return this._activityUntilMs;
  }

  /**
   * The camera-motion deadline, exposed for the EDL / adaptive-DPR signal.
   * Distinct from {@link activityUntilMs}: this one is extended only by camera
   * motion.
   */
  get cameraUntilMs(): number {
    return this._cameraUntilMs;
  }

  /** Extend the full-rate window after an input. `now` is `performance.now()`. */
  bump(now: number): void {
    this._activityUntilMs = now + RENDER_HOLDOVER_MS;
  }

  /**
   * Extend BOTH windows: the camera moved, so the loop draws at full rate and
   * the motion-gated effects stand down. Camera motion always wants full-rate
   * frames, so this never has to be paired with {@link bump}.
   */
  bumpCamera(now: number): void {
    this._activityUntilMs = now + RENDER_HOLDOVER_MS;
    this._cameraUntilMs = now + RENDER_HOLDOVER_MS;
  }

  /**
   * Draw this frame?
   *
   * Priority, highest first: a tween always draws; recent input draws until
   * the holdover expires; active streaming draws so new nodes appear without
   * latency; commit work draws so geometry that has reached the GPU is on the
   * screen rather than waiting for a heartbeat; otherwise the heartbeat draws
   * once the idle counter reaches the threshold. The boundary is
   * `now < until`, so the expiry instant is already idle.
   */
  shouldRender(now: number, signals: RenderActivitySignals): boolean {
    if (signals.tweening) return true;
    if (now < this._activityUntilMs) return true;
    if (signals.streamingBusy) return true;
    if (signals.commitWork) return true;
    return this._idleHeartbeat >= IDLE_HEARTBEAT_FRAMES;
  }

  /** The frame drew: reset the heartbeat so ticks stay evenly spaced. */
  noteRendered(): void {
    this._idleHeartbeat = 0;
  }

  /** The frame was skipped: advance toward the next heartbeat. */
  noteSkipped(): void {
    this._idleHeartbeat++;
  }
}

/**
 * The damping-settle gate travels with this module because it decides whether a
 * change event should arm the gate above at all. Viewer reaches both through
 * the one import: the module-graph ratchet counts a second edge from Viewer to
 * a module the activity cluster already owns, and the two are one concern.
 */
export { DampingSettleGate, decayRemaining, hasDampingSettled, SETTLED_REMAINING_PX } from './dampingSettle';

