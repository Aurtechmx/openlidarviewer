/**
 * dampingSettle.ts
 *
 * OrbitControls damping multiplies the pending camera delta by
 * `1 - dampingFactor` on every `update()` and dispatches a `change` event for
 * each tick whose camera movement clears its internal epsilon. That epsilon is
 * a world-space distance, so on a survey-scale scene the tail keeps firing for
 * on the order of a hundred frames after the pointer is released, long past
 * the point where the motion is visible.
 *
 * The decay is geometric, so the travel still to come is a closed form of the
 * step just taken:
 *
 *   step(n)      = d * v0 * (1 - d)^n
 *   remaining(n) = SUM over k > n of step(k)
 *                = v0 * (1 - d)^(n + 1)
 *                = step(n) * (1 - d) / d
 *
 * At d = 0.07 the remaining travel is 13.29 times the current step; at the
 * touch tuning d = 0.18 it is 4.56 times. Steps arrive as on-screen
 * displacement in CSS pixels, so the threshold is a perceptual quantity rather
 * than a scene-dependent one, and a hard flick keeps its full glide at full
 * rate while a gentle drag stops re-arming within a few ticks of release.
 *
 * Rotation, pan and dolly all decay at the same rate and all reach the screen
 * through the same projection, so one pixel measure covers the three.
 *
 * Pure: no three.js, no DOM. Tests in `tests/dampingSettle.test.ts`.
 */

import { quaternionAngle, type Quat } from './angularVelocity';
import { projectedPixels } from './pixelProjection';

/**
 * On-screen travel still to come, in CSS pixels, below which the damping tail
 * no longer needs full-rate frames.
 *
 * The render-activity gate falling idle does not stop the tail drawing: the
 * loop drops to its heartbeat, one rendered frame in `IDLE_HEARTBEAT_FRAMES +
 * 1` = 7. The largest jump any of those frames can show is
 * `7 * threshold * d / (1 - d)`, which at d = 0.07 and a 2 px threshold is
 * 1.05 px. The whole remainder is 2 px, drawn in roughly 1 px steps.
 */
export const SETTLED_REMAINING_PX = 2;

/** A camera orientation, structurally compatible with `THREE.Quaternion`. */
export interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/** A point, structurally compatible with `THREE.Vector3`. */
export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The camera fields the measure reads, satisfied by `THREE.PerspectiveCamera`. */
export interface SettleCamera {
  readonly quaternion: QuaternionLike;
  readonly position: Vector3Like;
  /** Vertical field of view in degrees. */
  readonly fov: number;
}

/** The control fields the measure reads, satisfied by `OrbitControls`. */
export interface SettleControls {
  readonly target: Vector3Like;
  readonly dampingFactor: number;
}

/**
 * Travel still to come in a geometric decay, in the units of `step`.
 *
 * A non-positive or non-finite step has nothing left to run. A non-positive
 * damping factor never decays, so the remainder is unbounded. A factor of 1 or
 * more zeroes the delta on the same tick, leaving nothing.
 */
export function decayRemaining(step: number, dampingFactor: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (!Number.isFinite(dampingFactor) || dampingFactor <= 0) return Number.POSITIVE_INFINITY;
  if (dampingFactor >= 1) return 0;
  return (step * (1 - dampingFactor)) / dampingFactor;
}

/**
 * On-screen displacement of content at the orbit target, in CSS pixels, for a
 * camera that rotated by `rotationRadians` and moved by `translation` world
 * units in one tick. The rotation is converted to its arc length at the target
 * distance so both terms project through `projectedPixels`.
 */
export function stepPixels(
  rotationRadians: number,
  translation: number,
  targetDistance: number,
  viewportHeightPx: number,
  fovYRadians: number,
): number {
  const distance = targetDistance > 1e-6 ? targetDistance : 1e-6;
  const arc = Math.abs(rotationRadians) * distance + Math.abs(translation);
  return projectedPixels(arc, distance, viewportHeightPx, fovYRadians);
}

/** Is the travel still to come below the perceptual threshold? */
export function hasDampingSettled(
  stepPx: number,
  dampingFactor: number,
  thresholdPx: number = SETTLED_REMAINING_PX,
): boolean {
  return decayRemaining(stepPx, dampingFactor) < thresholdPx;
}

/**
 * Turns a stream of camera poses into the answer "does this `change` event
 * still need a full-rate frame?".
 *
 * The first pose after construction has no predecessor to difference against
 * and arms. Every later pose is measured against the one before it, so any
 * motion above the threshold arms whatever produced it, and a decay below the
 * threshold does not. Within a pure decay the step falls monotonically, so the
 * answer never flips back on its own.
 *
 * The previous pose is held in mutable tuples so a per-frame call allocates
 * nothing.
 */
export class DampingSettleGate {
  private _hasPrev = false;
  private readonly _prevQuat: [number, number, number, number] = [0, 0, 0, 1];
  private readonly _quat: [number, number, number, number] = [0, 0, 0, 1];
  private _prevX = 0;
  private _prevY = 0;
  private _prevZ = 0;

  /** Re-arm the render-activity gate for this pose? */
  arms(camera: SettleCamera, controls: SettleControls, viewportHeightPx: number): boolean {
    const { quaternion: q, position: p } = camera;
    this._quat[0] = q.x;
    this._quat[1] = q.y;
    this._quat[2] = q.z;
    this._quat[3] = q.w;
    let armed = true;
    if (this._hasPrev) {
      const target = controls.target;
      const px = stepPixels(
        quaternionAngle(this._prevQuat as Quat, this._quat as Quat),
        Math.hypot(p.x - this._prevX, p.y - this._prevY, p.z - this._prevZ),
        Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z),
        viewportHeightPx,
        (camera.fov * Math.PI) / 180,
      );
      armed = !hasDampingSettled(px, controls.dampingFactor);
    }
    this._prevQuat[0] = this._quat[0];
    this._prevQuat[1] = this._quat[1];
    this._prevQuat[2] = this._quat[2];
    this._prevQuat[3] = this._quat[3];
    this._prevX = p.x;
    this._prevY = p.y;
    this._prevZ = p.z;
    this._hasPrev = true;
    return armed;
  }
}
