/**
 * viewCubeMath.ts
 *
 * Pure geometry behind the on-canvas ViewCube / compass gizmo. No three.js, no
 * DOM, so it is unit-tested in Node and the lazy widget (`src/ui/viewCube.ts`)
 * stays a thin renderer over it.
 *
 * The gizmo does two jobs:
 *   1. Show which way the camera is facing — a compass rose that rotates with
 *      the camera's heading around the world up axis.
 *   2. Snap to a standard view when a face / cardinal is clicked — the same six
 *      axis-aligned views the toolbar already exposes (v0.4.6).
 */

/** The six axis-aligned standard views the gizmo can snap to. */
export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Where a face sits around the rose. */
export type CompassFacePosition = 'top' | 'right' | 'bottom' | 'left';

/**
 * A clickable rose face. It carries TWO labels because the rose only has
 * cardinal directions when the scan's orientation is geographically known.
 * Even then the rose follows the scan's +Y axis, which is GRID north on a
 * projected CRS (true north differs by the meridian convergence, 1.29 degrees
 * in UTM 12N at 109 W, 40 N), so the top face reads "Grid N":
 *
 *   - `geo` (N/E/S/W) is shown ONLY when the active scan has a known geographic
 *     frame (a projected or geographic CRS). Then the cardinals are meaningful.
 *   - `local` (B/R/F/L) is the truthful fallback for a local / unknown-CRS scan.
 *     The rose's directions are derived from the scan's own axes, not from any
 *     coordinate system (`Viewer._horizontalAxis` is a synthetic worldUp-cross,
 *     with no CRS input), so calling them North/East for a local scan would
 *     assert geography the data does not carry. The faces still snap to the same
 *     Back/Right/Front/Left standard views — that is what B/R/F/L name.
 */
export interface CompassFace {
  readonly view: StandardView;
  readonly position: CompassFacePosition;
  readonly geo: string;
  readonly local: string;
}

/** Clickable compass faces, in render order around the rose (top face first). */
export const COMPASS_FACES: readonly CompassFace[] = [
  { view: 'back', position: 'top', geo: 'Grid N', local: 'B' },
  { view: 'right', position: 'right', geo: 'E', local: 'R' },
  { view: 'front', position: 'bottom', geo: 'S', local: 'F' },
  { view: 'left', position: 'left', geo: 'W', local: 'L' },
];

/** The label a face shows: geographic cardinal when known, else truthful local. */
export function compassFaceLabel(face: CompassFace, geographic: boolean): string {
  return geographic ? face.geo : face.local;
}

/**
 * Camera heading around the world up axis, in degrees [0, 360), from the
 * horizontal components of its forward vector. 0° = looking toward +North (the
 * `back` view looks north), increasing clockwise through East.
 *
 * `forwardEast` / `forwardNorth` are the camera forward vector's components in
 * the world ground plane (the two axes that are NOT the up axis); the caller
 * picks them from the scan's up-axis convention (Z-up vs Y-up).
 */
export function compassHeadingDeg(forwardEast: number, forwardNorth: number): number {
  if (!Number.isFinite(forwardEast) || !Number.isFinite(forwardNorth)) return 0;
  if (forwardEast === 0 && forwardNorth === 0) return 0;
  const deg = (Math.atan2(forwardEast, forwardNorth) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

/** Nearest cardinal label for a heading in degrees. */
export function nearestCardinal(headingDeg: number): 'N' | 'E' | 'S' | 'W' {
  const h = ((headingDeg % 360) + 360) % 360;
  if (h < 45 || h >= 315) return 'N';
  if (h < 135) return 'E';
  if (h < 225) return 'S';
  return 'W';
}

/**
 * The CSS rotation (degrees) to apply to the compass rose so that world North
 * stays pinned to screen-up as the camera turns. The rose counter-rotates the
 * heading.
 */
export function roseRotationDeg(headingDeg: number): number {
  return -(((headingDeg % 360) + 360) % 360);
}

/**
 * Below this horizontal magnitude of the (unit) forward vector the heading is
 * not trustworthy: the camera looks within ~0.57 degrees of straight up or
 * down, where atan2 of two near-zero components flips with floating-point
 * noise. 0.01 = sin(0.573 degrees). Consumers keep their last reliable heading
 * instead of snapping the rose back to north.
 */
export const NEAR_VERTICAL_HORIZONTAL_EPS = 0.01;

/**
 * {@link compassHeadingDeg} with a near-vertical guard: when the forward
 * vector's horizontal component magnitude is below
 * {@link NEAR_VERTICAL_HORIZONTAL_EPS} (or non-finite), returns `lastReliableDeg`
 * — NaN by default, which a display that unwraps with {@link unwrapAngleDeg}
 * treats as "hold the previous angle". Otherwise the canonical heading.
 */
export function stableHeadingDeg(forwardEast: number, forwardNorth: number, lastReliableDeg = Number.NaN): number {
  if (!Number.isFinite(forwardEast) || !Number.isFinite(forwardNorth)) return lastReliableDeg;
  if (Math.hypot(forwardEast, forwardNorth) < NEAR_VERTICAL_HORIZONTAL_EPS) return lastReliableDeg;
  return compassHeadingDeg(forwardEast, forwardNorth);
}

/**
 * Continuous display angle: moves from `prevDisplayDeg` to the angle that is
 * congruent to `nextCanonicalDeg` (mod 360) along the SHORTEST delta, so a CSS
 * rotation never spins the long way round when a heading crosses 0/360
 * (359 -> 1 moves +2, 1 -> 359 moves -2) and repeated turns accumulate.
 * A non-finite `nextCanonicalDeg` returns `prevDisplayDeg` unchanged; a
 * non-finite `prevDisplayDeg` (no display yet) starts from the canonical angle.
 * An exact half-turn resolves to +180.
 */
export function unwrapAngleDeg(prevDisplayDeg: number, nextCanonicalDeg: number): number {
  if (!Number.isFinite(nextCanonicalDeg)) return prevDisplayDeg;
  if (!Number.isFinite(prevDisplayDeg)) return nextCanonicalDeg;
  const prev = prevDisplayDeg;
  let delta = (((nextCanonicalDeg - prev) % 360) + 360) % 360; // [0, 360)
  if (delta > 180) delta -= 360;
  return prev + delta;
}
