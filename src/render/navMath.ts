/**
 * navMath.ts
 *
 * Pure, dependency-free movement math for the camera navigation system.
 *
 * Deliberately free of three.js so it can be unit-tested in Node and reused
 * by `NavController` without pulling in the renderer. `NavController` builds
 * the camera basis vectors (which depend on the cloud's up-axis and the
 * current look direction) and hands them here; this module does the rest.
 */

/** A 3-component vector as a plain tuple — matches the project's [x,y,z] style. */
export type Vec3 = [number, number, number];

/** Which directional movement keys are currently held. */
export interface MoveKeys {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** A point picked along a ray — the result of {@link nearestPointAlongRay}. */
export interface RayHit {
  /** Index of the point (not the array offset). */
  index: number;
  /** The point's xyz coordinates. */
  point: Vec3;
  /** Perpendicular distance from the ray line. */
  offset: number;
  /** Distance along the ray, from the origin to the closest approach. */
  along: number;
}

/**
 * The velocity the camera *wants* given the held keys and the camera basis.
 *
 * `forward`, `right` and `up` are the basis vectors each key pair moves along
 * (the caller orients them per navigation mode). The combined direction is
 * normalised — so diagonal movement is not faster — then scaled to `speed`
 * (units per second). With no keys held the result is the zero vector.
 */
export function desiredVelocity(
  keys: MoveKeys,
  forward: Vec3,
  right: Vec3,
  up: Vec3,
  speed: number,
): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  if (keys.forward)  { x += forward[0]; y += forward[1]; z += forward[2]; }
  if (keys.backward) { x -= forward[0]; y -= forward[1]; z -= forward[2]; }
  if (keys.right)    { x += right[0];   y += right[1];   z += right[2]; }
  if (keys.left)     { x -= right[0];   y -= right[1];   z -= right[2]; }
  if (keys.up)       { x += up[0];      y += up[1];      z += up[2]; }
  if (keys.down)     { x -= up[0];      y -= up[1];      z -= up[2]; }

  const length = Math.hypot(x, y, z);
  if (length < 1e-9) return [0, 0, 0];
  const k = speed / length;
  return [x * k, y * k, z * k];
}

/**
 * Smooth `current` velocity toward `target` with frame-rate-independent
 * exponential easing. `responsiveness` controls how quickly it converges
 * (higher = snappier); crucially the result is the same whether a frame ran
 * at 30 fps or 144 fps, so movement never feels different on a faster display.
 */
export function smoothVelocity(
  current: Vec3,
  target: Vec3,
  dt: number,
  responsiveness = 12,
): Vec3 {
  const t = 1 - Math.exp(-Math.max(dt, 0) * responsiveness);
  return [
    current[0] + (target[0] - current[0]) * t,
    current[1] + (target[1] - current[1]) * t,
    current[2] + (target[2] - current[2]) * t,
  ];
}

/**
 * A sensible base movement speed (units/second) for a cloud whose bounding
 * box's largest dimension is `maxDimension`. A room-sized scan moves slowly;
 * a kilometre-wide drone survey moves fast — so the same controls feel right
 * at every scale. A small floor keeps degenerate clouds navigable.
 */
export function speedForSize(maxDimension: number): number {
  return Math.max(maxDimension * 0.05, 0.05);
}

/** Cubic ease-in-out, used for camera tweens. Clamps `t` to [0, 1]. */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/**
 * Find the point in `positions` (interleaved xyz) closest to the ray defined
 * by `origin` and the **normalised** `dir`. Points behind the origin are
 * ignored; returns null for an empty array or a ray that misses everything
 * in front of it.
 *
 * Selection minimises the *angular* miss — perpendicular offset divided by
 * distance along the ray — so a near point and a far point are judged fairly.
 * That matches what "click on that point" means on screen.
 */
export function nearestPointAlongRay(
  positions: Float32Array,
  origin: Vec3,
  dir: Vec3,
): RayHit | null {
  let best: RayHit | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const vx = positions[i] - origin[0];
    const vy = positions[i + 1] - origin[1];
    const vz = positions[i + 2] - origin[2];
    const along = vx * dir[0] + vy * dir[1] + vz * dir[2];
    if (along <= 0) continue; // behind the camera
    const cx = origin[0] + dir[0] * along;
    const cy = origin[1] + dir[1] * along;
    const cz = origin[2] + dir[2] * along;
    const offset = Math.hypot(
      positions[i] - cx,
      positions[i + 1] - cy,
      positions[i + 2] - cz,
    );
    const score = offset / along; // angular miss — fair across depth
    if (score < bestScore) {
      bestScore = score;
      best = {
        index: i / 3,
        point: [positions[i], positions[i + 1], positions[i + 2]],
        offset,
        along,
      };
    }
  }
  return best;
}
