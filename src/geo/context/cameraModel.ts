/**
 * cameraModel.ts
 *
 * The pure camera-to-map mapping for Context View: where the 3D camera sits on
 * the world map, and which way it faces. The map marker is only honest if both
 * come straight from the camera state — so a degenerate (zero-length) view
 * direction yields `headingDeg: null` rather than a fabricated "north". The UI
 * must render a heading-less marker in that case, not invent an arrow.
 *
 * Reprojection is injected exactly as in {@link buildContextFootprint}: the
 * caller supplies (x, y) → [lonDeg, latDeg] | null; this module never imports
 * proj4. Heading is computed in the NATIVE XY frame (clockwise from +Y =
 * grid north), which is honest for the projected frames Context View admits;
 * meridian convergence is the caller's concern if it ever matters.
 *
 * Non-finite inputs are caller bugs and throw a TypeError naming the argument.
 */

import type { LonLatTransform } from './footprintModel';

/** The camera's placement on the map, or a refusal when it cannot be placed. */
export interface ContextCameraPlacement {
  /** Camera position as [lonDeg, latDeg]. */
  readonly position: readonly [number, number];
  /** View heading in degrees clockwise from north, or null when the direction is degenerate. */
  readonly headingDeg: number | null;
}

/** The camera position could not be transformed to lon/lat. */
export interface ContextCameraRefusal {
  readonly failed: true;
}

export type ContextCameraResult = ContextCameraPlacement | ContextCameraRefusal;

/**
 * Map the camera onto the world map. `dirX`/`dirY` is the view direction's XY
 * component and may be zero-length (looking straight down), which yields a
 * null heading — never a made-up one. Throws TypeError on non-finite inputs.
 */
export function mapCameraToContext(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  toLonLat: LonLatTransform,
): ContextCameraResult {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError('mapCameraToContext: "x"/"y" must be finite numbers');
  }
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY)) {
    throw new TypeError('mapCameraToContext: "dirX"/"dirY" must be finite numbers');
  }

  const ll = toLonLat(x, y);
  if (ll === null || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) {
    return { failed: true };
  }

  // Clockwise from north (+Y): atan2(east, north). A zero-length direction has
  // no heading; report null rather than defaulting to 0 (which IS north).
  let headingDeg: number | null = null;
  if (dirX !== 0 || dirY !== 0) {
    const raw = (Math.atan2(dirX, dirY) * 180) / Math.PI;
    headingDeg = ((raw % 360) + 360) % 360;
  }

  return { position: [ll[0], ll[1]], headingDeg };
}
