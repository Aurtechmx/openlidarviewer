/**
 * orthoZoomAnchor.ts — cursor-anchored zoom for the orthographic follower.
 *
 * In orthographic mode the image comes from the follower that
 * `followPerspective` builds each frame: the perspective master's pose, with a
 * frustum of half-height `orthoHalfHeight(distance, fov)` and half-width
 * `halfHeight · aspect`. A zoom step changes the camera-to-target distance and
 * so scales the frustum.
 *
 * An orthographic image has no depth. The world point under the cursor is fixed
 * by its offset from the camera axis in the view plane, whatever its depth. When
 * the frustum scales by `r = newHalf / oldHalf`, that offset's screen position
 * scales by `1 / r`. Translating camera and target together by
 * `offset · (1 − r)` along the camera's right and up axes puts every point that
 * was under the cursor back under it.
 *
 * The perspective dolly in `NavController` moves the camera along the ray
 * through the cursor instead, which anchors the point in a perspective image but
 * not in the orthographic one; this module is the orthographic counterpart.
 */

import * as THREE from 'three';
import { orthoAspect, orthoHalfHeight } from './orthoCamera';

/** A translation in the view plane, in world units along the camera's right and up axes. */
export interface ViewPlaneShift {
  readonly right: number;
  readonly up: number;
}

/** A lens shift in NDC: how far the image is moved right (`x`) and up (`y`). */
export interface LensShiftNdc {
  readonly x: number;
  readonly y: number;
}

/** The slice of a three.js camera's view offset this module reads. */
interface ViewOffsetLike {
  readonly view: {
    readonly enabled: boolean;
    readonly fullWidth: number;
    readonly fullHeight: number;
    readonly offsetX: number;
    readonly offsetY: number;
  } | null;
}

/**
 * The lens shift a camera's view offset carries, in NDC. `setLensShift` moves
 * the image up by `ndcY` with an offset of `ndcY / 2` of the full height; a
 * sub-window offset of `o` moves the image by `2o / full` the other way on x.
 * Zero when the camera has no view offset.
 */
export function lensShiftNdc(camera: ViewOffsetLike): LensShiftNdc {
  const v = camera.view;
  if (!v || !v.enabled || !(v.fullWidth > 0) || !(v.fullHeight > 0)) return { x: 0, y: 0 };
  return { x: (-2 * v.offsetX) / v.fullWidth, y: (2 * v.offsetY) / v.fullHeight };
}

/**
 * The view-plane translation that keeps the point under the cursor fixed when an
 * orthographic frustum's half-height changes from `oldHalfH` to `newHalfH`.
 * `axisX` and `axisY` are the cursor's NDC measured from the camera axis (the
 * cursor NDC minus any lens shift); `aspect` is the frustum's width / height.
 */
export function orthoAnchorShift(
  axisX: number,
  axisY: number,
  oldHalfH: number,
  newHalfH: number,
  aspect: number,
): ViewPlaneShift {
  if (!(oldHalfH > 0) || !(newHalfH > 0)) return { right: 0, up: 0 };
  const keep = 1 - newHalfH / oldHalfH;
  return { right: axisX * oldHalfH * aspect * keep, up: axisY * oldHalfH * keep };
}

const _offset = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Set the perspective master's camera-to-target distance to `nextDist` so that
 * the orthographic follower keeps the world point under the cursor (`ndcX`,
 * `ndcY`, in the canvas's NDC) where it is on screen. The camera keeps its
 * orientation; camera and target move together in the view plane. Reads the
 * master's fov, aspect and lens shift, which the follower copies. Returns false
 * and changes nothing when the distance is degenerate.
 */
export function orthoCursorDolly(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  ndcX: number,
  ndcY: number,
  nextDist: number,
): boolean {
  const offset = _offset.subVectors(camera.position, target);
  const dist = offset.length();
  if (!(dist > 1e-6) || !(nextDist > 0) || !Number.isFinite(nextDist)) return false;
  const lens = lensShiftNdc(camera);
  const shift = orthoAnchorShift(
    ndcX - lens.x,
    ndcY - lens.y,
    orthoHalfHeight(dist, camera.fov),
    orthoHalfHeight(nextDist, camera.fov),
    orthoAspect(camera.aspect),
  );
  camera.position.copy(target).addScaledVector(offset, nextDist / dist);
  _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  for (const p of [camera.position, target]) {
    p.addScaledVector(_right, shift.right).addScaledVector(_up, shift.up);
  }
  return true;
}
