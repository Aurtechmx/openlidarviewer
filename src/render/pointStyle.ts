/**
 * pointStyle.ts
 *
 * The pure mathematics of adaptive point sizing — how a point's on-screen
 * pixel size varies with its distance from the camera.
 *
 * No three.js or DOM dependency, so it is unit-tested in Node. The GPU-side
 * size node (in `Viewer.ts`) mirrors `adaptivePointSize` exactly.
 */

import { clamp } from '../numeric';

/** How point size responds to camera distance. */
export type PointSizeMode = 'adaptive' | 'fixed';

/** Default adaptive-sizing tuning. */
export const POINT_STYLE_DEFAULTS = {
  /** Far points never shrink below this many device pixels. */
  minSizePx: 1,
  /** Near points never exceed `base size × this`. */
  maxSizeFactor: 3,
  /**
   * Sizing mode applied to a freshly loaded cloud. Defaults to `fixed`: a
   * constant 1-pixel point is the most honest first view of a cloud — no
   * distance-driven size gradient to read as banding on an oblique surface,
   * no fat overlapping points to exaggerate density variation. Adaptive
   * sizing stays one tap away and is remembered once chosen.
   */
  mode: 'fixed' as PointSizeMode,
} as const;

/**
 * On-screen pixel size of a point under adaptive attenuation.
 *
 * A point at `referenceDist` renders at exactly `baseSizePx`; nearer points
 * grow and farther points shrink with a `1 / distance` perspective falloff,
 * but the result is clamped to `[minPx, maxPx]` so far points stay visible
 * (the cloud reads as continuous) and near points never bloat.
 *
 * `fixed` mode is simply this function bypassed — the point is always
 * `baseSizePx` — and is handled by the caller, not here.
 *
 * @param baseSizePx - The user's chosen base point size, in device pixels.
 * @param eyeDist - The point's eye-space distance from the camera (> 0).
 * @param referenceDist - Distance at which a point shows at `baseSizePx` (> 0).
 * @param minPx - Lower clamp, in device pixels.
 * @param maxPx - Upper clamp, in device pixels.
 */
export function adaptivePointSize(
  baseSizePx: number,
  eyeDist: number,
  referenceDist: number,
  minPx: number,
  maxPx: number,
): number {
  // A degenerate distance falls back to the largest allowed size rather than
  // dividing by zero — a point on the camera plane is, in effect, very near.
  if (eyeDist <= 0 || referenceDist <= 0) return maxPx;
  const attenuated = baseSizePx * (referenceDist / eyeDist);
  return clamp(attenuated, minPx, maxPx);
}

/**
 * The upper size clamp for a given base size: `baseSizePx × maxSizeFactor`,
 * but never less than the base itself.
 */
export function maxPointSize(baseSizePx: number, maxSizeFactor: number): number {
  return Math.max(baseSizePx, baseSizePx * maxSizeFactor);
}
