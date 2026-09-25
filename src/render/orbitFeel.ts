/**
 * orbitFeel.ts
 *
 * The set of tunables that describes "how the orbit camera feels" — pulled
 * out as a pure module so the values are documented in one place,
 * regression-guarded by tests, and importable by both Viewer.ts (browser)
 * and the Node test suite.
 *
 * The constants here were tuned through v0.3.6's smoothness pass and the
 * follow-up "axis feels weird" debug fix:
 *
 *   • DAMPING_FACTOR — three.js OrbitControls' damping (lower = longer
 *     glide after release). The v0.3.5 baseline was 0.08 (snappy). The
 *     smoothness pass first tried 0.05 (model-viewer's default) but that
 *     over-coasted on UTM-scale survey scenes. 0.07 is the settled middle
 *     — a hair smoother than v0.3.5, no over-coast on large scenes.
 *
 *   • ROTATE_SPEED — multiplier on rotate-gesture angular velocity. 0.85
 *     was the v0.3.5 baseline (deliberately slowed for survey work). The
 *     first smoothness pass tried 1.0 (default) but combined with lower
 *     damping it made the rotation feel slippery. 0.95 keeps the active
 *     drag responsive without the over-coast.
 *
 *   • SETTLE_MS — the grace window after OrbitControls' 'end' event during
 *     which the orbit-centre maintenance pass (soft-clamp + streaming
 *     refinement) suspends itself. Without this gap, the maintenance lerp
 *     ran *during* OrbitControls' damping tail, producing the "weird axis"
 *     feel reported in v0.3.6. 280 ms is long enough for a 60-fps damping
 *     curve at 0.07 to decay below the noise floor.
 *
 *   • SOFT_CLAMP_LERP_PER_FRAME — when the orbit target drifts outside the
 *     inflated cloud AABB, the maintenance pass lerps it back at this rate
 *     per frame. 0.12 produces a smooth ~0.5 s pull-back glide rather than
 *     a one-frame snap. Test convergence is below.
 *
 *   • STREAMING_LERP_PER_FRAME — streaming-bounds refinement lerp factor.
 *     Set deliberately low so the orbit target glides toward the live cloud
 *     centre as new octree nodes finish decoding without ever snapping.
 *
 *   • EXPAND_FRACTION — envelope inflation as a fraction of the AABB
 *     diagonal. 0.25 gives the user freedom to pan past the edge of the
 *     cloud for inspection without ever orbiting empty space.
 *
 * Pure — no DOM, no three.js. Tests in `tests/orbitFeel.test.ts`.
 */
import { SETTLED_REMAINING_PX, stepPixels } from './dampingSettle';

/** OrbitControls dampingFactor. Lower = longer glide after release. */
export const DAMPING_FACTOR = 0.07;

/** OrbitControls rotateSpeed multiplier on rotate-gesture velocity. */
export const ROTATE_SPEED = 0.95;

/**
 * Touch-specific tuning. OrbitControls applies the same `rotateSpeed`
 * and `dampingFactor` to both mouse and touch input, but a finger drag
 * across a 375 px phone screen needs to translate to a different camera
 * rotation than a mouse drag across a 1440 px desktop. Lower rotate
 * speed makes inspection precise; higher damping factor (shorter glide)
 * makes the camera stop when the finger lifts instead of coasting off
 * the model. Picked empirically against an iPhone-class device.
 */
export const ROTATE_SPEED_TOUCH = 0.55;
export const DAMPING_FACTOR_TOUCH = 0.18;

/**
 * Grace window after the last OrbitControls 'end' event, in milliseconds.
 * The orbit-centre maintenance pass skips itself within this window so the
 * soft-clamp pull-back doesn't race the damping tail.
 */
export const SETTLE_MS = 280;

/** Per-frame lerp factor for soft-clamping the orbit target back into the AABB. */
export const SOFT_CLAMP_LERP_PER_FRAME = 0.12;

/** Per-frame lerp factor for streaming-bounds refinement of the orbit target. */
export const STREAMING_LERP_PER_FRAME = 0.05;

/** Longest frame step the time-based factors integrate, in seconds. */
export const MAX_FEEL_DT_SEC = 0.1;

/**
 * Convert a per-frame factor tuned at 60 Hz into the factor for a frame of
 * `dtSec` seconds, so the fraction covered per unit of wall time is the same
 * at any refresh rate: `1 - (1 - k) ** (dtSec * 60)`. At 1/60 s it returns
 * `k`. `dtSec` is clamped to [0, {@link MAX_FEEL_DT_SEC}] so a stalled frame
 * cannot jump the camera the whole way.
 */
export function perFrameToDt(k: number, dtSec: number): number {
  const dt = Number.isFinite(dtSec) ? Math.min(Math.max(dtSec, 0), MAX_FEEL_DT_SEC) : 0;
  return 1 - (1 - k) ** (dt * 60);
}

/**
 * Rest rule for the post-drag glide. OrbitControls' damping shrinks the
 * pending rotation and pan by a constant fraction per update and never
 * reaches zero, so without a floor the camera creeps for as long as the loop
 * keeps updating it. Once the render loop stops drawing the tail at full
 * rate (dampingSettle.ts: under `SETTLED_REMAINING_PX` of travel left) it
 * drops to its idle heartbeat, and every heartbeat then moves the camera by a
 * visible fraction of a pixel and counts as motion again: the view kept
 * switching its stationary rendering (EDL) on and off for seconds.
 *
 * So the glide is dropped at the point the loop stops drawing it: when the
 * on-screen travel still to come is under `SETTLED_REMAINING_PX`. Where the
 * viewport is unknown, a relative floor applies instead: the share a 60 Hz
 * update would apply under {@link GLIDE_REST_ROTATION_RAD} of rotation or
 * {@link GLIDE_REST_PAN_REL} of the target distance of pan.
 */
export const GLIDE_REST_ROTATION_RAD = 1e-5;
export const GLIDE_REST_PAN_REL = 1e-6;

/** The viewport the on-screen rule projects through. */
export interface GlideView {
  readonly heightPx: number;
  readonly fovYRad: number;
}

/**
 * The shared rest rule: a glide is at rest when it has nothing left, when the
 * share one 60 Hz update would apply (`perUpdate`, in the unit `floor` is in)
 * is under `floor`, or when the on-screen travel still to come
 * (`remainingPx`, null when the viewport is unknown) is under
 * `SETTLED_REMAINING_PX`.
 */
export function glideRestRule(remainingPx: number | null, perUpdate: number, floor: number): boolean {
  const share = Math.abs(perUpdate);
  if (share === 0 || !Number.isFinite(share)) return true;
  if (share < floor) return true;
  return remainingPx !== null && remainingPx < SETTLED_REMAINING_PX;
}

/**
 * Which parts of an OrbitControls glide are at rest: `delta` is its pending
 * rotation (theta, phi in rad), `pan` its pending target offset, `distance`
 * the camera-to-target distance, `dampingFactor` the per-60 Hz factor and
 * `view` the viewport, or null when unknown. The whole pending delta is the
 * travel still to come.
 */
export function glideAtRest(
  delta: { readonly theta: number; readonly phi: number },
  pan: { readonly x: number; readonly y: number; readonly z: number },
  distance: number,
  dampingFactor: number,
  view: GlideView | null = null,
): { rotation: boolean; pan: boolean } {
  const k = Number.isFinite(dampingFactor) && dampingFactor > 0 ? Math.min(dampingFactor, 1) : 1;
  const rot = Math.hypot(delta.theta, delta.phi);
  const move = Math.hypot(pan.x, pan.y, pan.z);
  const d = Math.max(distance, 0);
  const px = (angle: number, shift: number): number | null =>
    view === null ? null : stepPixels(angle, shift, d, view.heightPx, view.fovYRad);
  return {
    rotation: glideRestRule(px(rot, 0), rot * k, GLIDE_REST_ROTATION_RAD),
    pan: glideRestRule(px(0, move), move * k, GLIDE_REST_PAN_REL * d),
  };
}

/**
 * Travel still to come of a velocity `v` decaying as `exp(-rate * t)` and
 * integrated in steps of at most {@link MAX_FEEL_DT_SEC}, counting the step
 * about to be taken: at most `v / rate + v * MAX_FEEL_DT_SEC` (the stepped
 * sum `v dt / (1 - exp(-rate dt))` is under it for any step length).
 */
function decayTravel(v: number, rate: number): number {
  return rate > 0 ? v / rate + v * MAX_FEEL_DT_SEC : Number.POSITIVE_INFINITY;
}

/**
 * Whether an exponentially decaying orbit velocity (rad/s, decaying as
 * `exp(-rate * t)`) is at rest. Used for the arrow-key orbit once its keys
 * are up.
 */
export function orbitVelocityAtRest(speedRadPerSec: number, rate: number, distance: number, view: GlideView | null): boolean {
  const speed = Math.abs(speedRadPerSec);
  const remaining = decayTravel(speed, rate);
  const px = view === null ? null : stepPixels(remaining, 0, Math.max(distance, 0), view.heightPx, view.fovYRad);
  return glideRestRule(px, speed / 60, GLIDE_REST_ROTATION_RAD);
}

/**
 * Whether a log-space dolly velocity (per second, decaying as
 * `exp(-friction * t)`) is at rest. The log-scale still to come moves content
 * at the viewport edge by `heightPx / 2 * |exp(remaining) - 1|` pixels. The
 * relative floor is the share of the target distance one 60 Hz update changes.
 */
export function dollyVelocityAtRest(velocity: number, friction: number, view: GlideView | null): boolean {
  const remaining = Math.sign(velocity) * decayTravel(Math.abs(velocity), friction);
  const px = view === null ? null : (view.heightPx / 2) * Math.abs(Math.expm1(remaining));
  return glideRestRule(px, velocity / 60, GLIDE_REST_PAN_REL);
}

/**
 * Envelope inflation expressed as a fraction of the AABB diagonal.
 * v0.3.6: bumped 0.25 → 0.4 after users on large aerial surveys hit the
 * clamp boundary while still well within useful pan range. 40% of a 1 km
 * scan's diagonal is ~570 m of pan headroom on each side; on a small
 * indoor scan it's still tight enough that you can't fly into the void.
 */
export const EXPAND_FRACTION = 0.4;

/**
 * True while the orbit-centre maintenance pass should suspend itself
 * because OrbitControls' damping is still settling after a gesture.
 *
 * `nowMs` and `lastInteractMs` are both monotonically-increasing high-res
 * timestamps in milliseconds; `performance.now()` in browsers, `Date.now()`
 * as a fallback. The function is pure — pulled out of Viewer.ts so the
 * timing contract is unit-testable in Node.
 *
 * Edge cases:
 *   • `lastInteractMs === 0` (no gesture yet) → false; the maintenance pass
 *     runs as soon as a cloud attaches.
 *   • `lastInteractMs > nowMs` (clock skew) → false; we don't trap forever.
 */
export function isWithinSettleWindow(
  nowMs: number,
  lastInteractMs: number,
  settleMs: number = SETTLE_MS,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastInteractMs)) return false;
  if (lastInteractMs <= 0) return false;
  const delta = nowMs - lastInteractMs;
  if (delta < 0) return false;
  return delta < settleMs;
}
