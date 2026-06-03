/**
 * orbitCenter.ts
 *
 * Pure helpers behind the v0.3.6 volumetric-orbit fix.
 *
 * The Viewer's orbit controls rotate the camera around a single world-space
 * point: `controls.target`. Historically that target sat at the dataset's
 * coordinate origin, which is rarely the visual centre of a scan — LAS / LAZ
 * captures carry large translated coordinates (UTM eastings in the millions),
 * so orbiting felt visibly off-axis. This module ships the small set of pure
 * calculations the Viewer uses to keep the orbit pivot anchored to the cloud:
 *
 *   • `aabbCenter` — the volumetric centre of an AABB (treated as the default
 *     orbit pivot for both static and streaming clouds).
 *   • `aabbDiagonal` — the diagonal length of the AABB, the natural unit for
 *     the soft-clamp envelope.
 *   • `clampTargetToExpandedAabb` — soft-clamps a candidate orbit target to a
 *     bounding box inflated by a fraction of its diagonal, so the user can
 *     pan slightly past the edge for inspection without losing the cloud into
 *     empty space.
 *   • `lerpTowardCenter` — the smoothing primitive streaming refinement uses
 *     so the orbit target never *snaps* as new octree nodes arrive — it
 *     glides toward the updated centre over many frames.
 *
 * Pure — no three.js, no DOM. Unit-tested in `tests/orbitCenter.test.ts`.
 */

/** Six-tuple AABB: `[minX, minY, minZ, maxX, maxY, maxZ]` in render space. */
export type Aabb = readonly [number, number, number, number, number, number];

/** A simple 3-vector. Plain tuple — kept free of three.js for testability. */
export type Vec3Tuple = readonly [number, number, number];

/** Volumetric centre of the AABB (component-wise mid-point). */
export function aabbCenter(aabb: Aabb): Vec3Tuple {
  return [
    (aabb[0] + aabb[3]) * 0.5,
    (aabb[1] + aabb[4]) * 0.5,
    (aabb[2] + aabb[5]) * 0.5,
  ];
}

/** Diagonal length of the AABB — handy as a natural unit of "cloud size". */
export function aabbDiagonal(aabb: Aabb): number {
  const w = aabb[3] - aabb[0];
  const d = aabb[4] - aabb[1];
  const h = aabb[5] - aabb[2];
  return Math.hypot(w, d, h);
}

/**
 * Soft-clamp a candidate orbit target inside the cloud's AABB inflated by a
 * fraction of its diagonal — the default 25 % gives the user freedom to pan
 * past the cloud edge for inspection without ever orbiting around empty
 * space. Both inputs must be finite; non-finite components are passed through
 * unchanged so a stray `NaN` doesn't poison the camera state.
 *
 * Returns a freshly allocated tuple so the caller can write back into a
 * three.js vector explicitly — never silently mutates `target`.
 */
export function clampTargetToExpandedAabb(
  target: Vec3Tuple,
  aabb: Aabb,
  expandFraction = 0.25,
): Vec3Tuple {
  const diag = aabbDiagonal(aabb);
  // A zero-extent or NaN AABB can't constrain anything — return the target
  // unchanged so the caller's camera state is left alone.
  if (!Number.isFinite(diag) || diag === 0) return [target[0], target[1], target[2]];
  const pad = diag * Math.max(0, expandFraction);
  const minX = aabb[0] - pad;
  const minY = aabb[1] - pad;
  const minZ = aabb[2] - pad;
  const maxX = aabb[3] + pad;
  const maxY = aabb[4] + pad;
  const maxZ = aabb[5] + pad;
  const cx = clampOrPass(target[0], minX, maxX);
  const cy = clampOrPass(target[1], minY, maxY);
  const cz = clampOrPass(target[2], minZ, maxZ);
  return [cx, cy, cz];
}

/** Standard linear-interpolation primitive between two 3-vectors. */
export function lerpTowardCenter(
  current: Vec3Tuple,
  desired: Vec3Tuple,
  t: number,
): Vec3Tuple {
  const k = Math.max(0, Math.min(1, t));
  return [
    current[0] + (desired[0] - current[0]) * k,
    current[1] + (desired[1] - current[1]) * k,
    current[2] + (desired[2] - current[2]) * k,
  ];
}

/**
 * Euclidean distance between two 3-vectors — used by the Viewer's streaming
 * refinement gate to decide whether a bounds update warrants a lerp tick.
 */
export function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function clampOrPass(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return value;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
