/**
 * panMath.ts
 *
 * Pure, dependency-free geometry and input-mapping logic for the P1 hand
 * tool (grab-and-drag panning) — docs/_audit/v0.5.5-program.md §P1.
 *
 * Deliberately free of three.js so it can be unit-tested in Node, in the
 * same spirit as `navMath.ts`: `NavController` builds the browser-bound
 * pieces (pointer events, camera rays, cursors) and hands the numbers here.
 *
 * The drag model — "locked plane":
 *
 *   1. At pointer-down a world-space plane is locked: normal along the
 *      camera's forward axis, passing through the orbit target.
 *   2. The initial pointer ray is intersected with that plane — the hit is
 *      the grabbed world point `W`.
 *   3. Every subsequent pointer ray is intersected with the SAME plane
 *      (never recomputed mid-gesture), giving the current hit `P`.
 *   4. Camera AND target translate by `Δ = W − P`. Because `W` and `P`
 *      both lie on the plane, `Δ` is parallel to it; the camera's
 *      orientation and camera-target distance are preserved exactly, and
 *      after the translation the ray re-intersects the plane exactly at
 *      `W` — the grabbed point stays under the pointer 1:1.
 *
 * Precision: all math here runs on plain JS numbers (float64) in the
 * viewer's recentred local frame (`src/io/coordinateBridge.ts` subtracts a
 * per-cloud integer origin while still in double precision), so pan deltas
 * are never accumulated into float32 world-scale coordinates.
 */

import type { Vec3 } from './navMath';

/**
 * The kind of hand-tool gesture a pointer-down may start:
 *
 *   - `'pan'`  — a primary drag while the hand tool (pan mode) is active.
 *   - `'temp'` — a temporary middle-mouse grab, available in ANY mode; the
 *                active mode is untouched, so releasing the button trivially
 *                "restores" the prior behavior.
 */
export type PanGestureKind = 'pan' | 'temp';

/**
 * Decide whether a pointer-down starts a hand-tool gesture.
 *
 * Pure gate for `NavController`'s pointerdown handler:
 *   - everything is off when the `?handPan=off` dev flag disabled the tool;
 *   - middle mouse (button 1) is a temporary grab in any mode;
 *   - in pan mode, a primary mouse/pen drag or a SINGLE-touch drag pans —
 *     a second finger belongs to the two-finger twist/pinch/pan recogniser
 *     (Viewer.ts), which stays authoritative for two pointers.
 */
export function panGestureKind(input: {
  /** `PointerEvent.button` (0 primary, 1 middle/auxiliary). */
  button: number;
  /** `PointerEvent.pointerType` — 'mouse' | 'pen' | 'touch'. */
  pointerType: string;
  /** The active navigation mode. */
  mode: string;
  /** The `?handPan` dev flag (default true). */
  handPanEnabled: boolean;
  /** Touch pointers currently down on the canvas, INCLUDING this one. */
  activeTouchCount: number;
}): PanGestureKind | null {
  if (!input.handPanEnabled) return null;
  if (input.pointerType === 'touch') {
    // One-finger drag pans while the hand tool is active; two or more
    // fingers are owned by the Viewer's two-finger recogniser.
    return input.mode === 'pan' && input.activeTouchCount === 1 ? 'pan' : null;
  }
  if (input.button === 1) return 'temp';
  if (input.button === 0 && input.mode === 'pan') return 'pan';
  return null;
}

/**
 * Resolve a mode-switching key for the hand tool. Returns the mode to switch
 * to, or null when the key is not a hand-tool binding (or the flag is off).
 *
 *   - Digit4 joins the Digit1/2/3 group → pan mode.
 *   - KeyG toggles pan from anywhere: pan ⇄ back to orbit.
 */
export function panModeForKey(
  code: string,
  currentMode: string,
  handPanEnabled: boolean,
): 'pan' | 'orbit' | null {
  if (!handPanEnabled) return null;
  if (code === 'Digit4') return 'pan';
  if (code === 'KeyG') return currentMode === 'pan' ? 'orbit' : 'pan';
  return null;
}

/** Guard against grazing rays / degenerate normals in the plane intersect. */
const RAY_PLANE_EPS = 1e-9;

/**
 * Intersect a ray with a plane. Returns the hit point, or null when the ray
 * is parallel to the plane (grazing) or the plane lies behind the origin —
 * the caller falls back to the screen-space model then.
 */
export function intersectRayPlane(
  origin: Vec3,
  dir: Vec3,
  planePoint: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const denom =
    dir[0] * planeNormal[0] + dir[1] * planeNormal[1] + dir[2] * planeNormal[2];
  if (Math.abs(denom) < RAY_PLANE_EPS) return null;
  const t =
    ((planePoint[0] - origin[0]) * planeNormal[0] +
      (planePoint[1] - origin[1]) * planeNormal[1] +
      (planePoint[2] - origin[2]) * planeNormal[2]) /
    denom;
  if (!Number.isFinite(t) || t <= 0) return null;
  return [
    origin[0] + dir[0] * t,
    origin[1] + dir[1] * t,
    origin[2] + dir[2] * t,
  ];
}

/**
 * The world-space translation for one drag step on the locked plane:
 * `Δ = grab − hit`, where `hit` is the current pointer ray intersected with
 * the locked plane. Null when the intersection is unavailable (grazing) —
 * fall back to {@link screenPanDelta}.
 *
 * Applying Δ to camera AND target re-anchors the grabbed point under the
 * pointer exactly (see the module header for the proof sketch).
 */
export function panPlaneDelta(
  rayOrigin: Vec3,
  rayDir: Vec3,
  grabPoint: Vec3,
  planePoint: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const hit = intersectRayPlane(rayOrigin, rayDir, planePoint, planeNormal);
  if (!hit) return null;
  return [
    grabPoint[0] - hit[0],
    grabPoint[1] - hit[1],
    grabPoint[2] - hit[2],
  ];
}

/**
 * Screen-space fallback when the ray-plane intersection is unstable:
 * translate along the camera's right/up axes by world-units-per-pixel at the
 * target distance — the same idiom as OrbitControls' own pan and the
 * Viewer's two-finger recogniser. `dist` is clamped away from zero so a
 * camera sitting on its target cannot produce a degenerate scale.
 *
 * Signs: pointer right (+dxPx) drags the scene right, so the camera moves
 * LEFT; canvas Y grows downward, so pointer down (+dyPx) moves the camera UP.
 */
export function screenPanDelta(
  dxPx: number,
  dyPx: number,
  clientHeight: number,
  fovDeg: number,
  dist: number,
  right: Vec3,
  up: Vec3,
): Vec3 {
  const safeDist = Math.max(dist, 1e-6);
  const fov = fovDeg * (Math.PI / 180);
  const worldPerPx =
    (2 * Math.tan(fov / 2) * safeDist) / Math.max(1, clientHeight);
  const tx = -dxPx * worldPerPx;
  const ty = dyPx * worldPerPx;
  return [
    right[0] * tx + up[0] * ty,
    right[1] * tx + up[1] * ty,
    right[2] * tx + up[2] * ty,
  ];
}
