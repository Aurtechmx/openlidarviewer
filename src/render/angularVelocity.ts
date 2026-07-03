/**
 * angularVelocity.ts
 *
 * Pure quaternion angular-distance maths for the P3 motion model (program §P3).
 * Camera rotation velocity must come from the true geodesic angle between two
 * orientations — NOT wrapped Euler differences, which jump at ±180° — so that
 * pure rotation registers as motion for the scheduler while a stationary camera
 * reads ~0. Sign-flip safe: a quaternion `q` and its negation `−q` denote the
 * same rotation (the double cover), and this must not read as a 2π spin.
 *
 * No three import — a 4-tuple `[x, y, z, w]` is all these need, so a typo is
 * caught by the suite rather than by watching the loader stutter.
 */

/** Unit (or near-unit) quaternion as `[x, y, z, w]`. */
export type Quat = readonly [number, number, number, number];

/**
 * Geodesic angle (radians) between two orientations. Uses `|dot|` so the double
 * cover `q ≡ −q` does not create a phantom rotation, and clamps the dot into
 * `[0, 1]` so float error near identity (or a slightly non-unit input) can't
 * push `acos` out of domain and return `NaN`.
 */
export function quaternionAngle(a: Quat, b: Quat): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const clamped = Math.min(1, Math.abs(dot));
  return 2 * Math.acos(clamped);
}

/**
 * Angular speed (radians per second) between the previous and current
 * orientation over `dtSec`. Returns 0 for a non-positive dt (no basis to divide).
 */
export function angularVelocity(prev: Quat, curr: Quat, dtSec: number): number {
  if (!(dtSec > 0)) return 0;
  return quaternionAngle(prev, curr) / dtSec;
}
