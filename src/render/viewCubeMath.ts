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

/** Clickable compass faces, in render order around the rose (N at top). */
export const COMPASS_FACES: readonly { readonly view: StandardView; readonly label: string }[] = [
  { view: 'back', label: 'N' },
  { view: 'right', label: 'E' },
  { view: 'front', label: 'S' },
  { view: 'left', label: 'W' },
];

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
