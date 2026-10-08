/**
 * workplaneView.ts
 *
 * Where the camera is looking on the reference plane, and how many CSS pixels
 * one source unit covers there: the two inputs the spacing choice and the
 * drawn patch need. Read from the public camera state (position, target, field
 * of view, projection) so it works the same in perspective, true orthographic
 * and Plan view, which is orthographic looking straight down.
 *
 * Scale at the focus: a perspective camera with vertical field of view `fov`
 * shows a height of `2 d tan(fov / 2)` at depth `d` over the canvas height.
 * The orthographic camera follows the perspective one with the same half
 * height at the orbit distance (`orthoCamera.followPerspective`), so it uses
 * the orbit distance in place of the depth.
 *
 * Pure: no DOM, no three.js.
 */

import {
  add,
  length,
  projectOntoPlane,
  rayPlaneHit,
  sub,
  toPlaneCoords,
  type Vec3,
  type WorkplaneBasis,
} from './workplanePlane';

export interface WorkplaneCamera {
  /** Scene coordinates. */
  readonly position: Vec3;
  readonly target: Vec3;
  /** Vertical field of view, degrees. */
  readonly fovDeg: number;
  readonly orthographic: boolean;
}

export interface WorkplaneViewSample {
  /** Plane coordinates of the focus. */
  readonly focus: readonly [number, number];
  /** CSS pixels per source unit at the focus; 0 when it cannot be measured. */
  readonly pxPerUnit: number;
}

/**
 * Sample the view. `sceneOrigin` turns scene coordinates into source
 * coordinates (source = scene + sceneOrigin), in Float64.
 */
export function sampleWorkplaneView(
  camera: WorkplaneCamera,
  plane: WorkplaneBasis,
  sceneOrigin: Vec3,
  canvasCssHeight: number,
): WorkplaneViewSample {
  const pos = add(camera.position, sceneOrigin);
  const tgt = add(camera.target, sceneOrigin);
  // Where the line of sight meets the plane; when it runs parallel or away
  // from the plane, the orbit target dropped onto the plane stands in.
  const hit = camera.orthographic ? null : rayPlaneHit(pos, tgt, plane);
  const focusPoint = hit ?? projectOntoPlane(tgt, plane);
  const orbit = length(sub(tgt, pos));
  const depth = camera.orthographic ? orbit : Math.min(length(sub(focusPoint, pos)), orbit * 50);
  const fov = (camera.fovDeg * Math.PI) / 180;
  const worldPerPx = (2 * depth * Math.tan(fov / 2)) / canvasCssHeight;
  const pxPerUnit = Number.isFinite(worldPerPx) && worldPerPx > 0 ? 1 / worldPerPx : 0;
  return { focus: toPlaneCoords(focusPoint, plane), pxPerUnit };
}
