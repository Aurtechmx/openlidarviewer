/**
 * orthoCamera.ts — the three.js side of the second (orthographic) camera.
 *
 * Increment 2 of the orthographic-camera work. The pure geometry lives in
 * `orthoProjection.ts`; this holds the thin three.js wrappers the Viewer calls
 * so the Viewer itself stays lean: build the camera, copy a pose between two
 * cameras (the inactive one shadows the active master so a projection switch is
 * seamless), and fit the ortho frustum to the scene. OrbitControls drives dolly
 * through `camera.zoom`, so the fit sets the zoom-1 frustum and leaves zoom to
 * the controls.
 */

import * as THREE from 'three';
import { orthoHalfExtents } from './orthoProjection';
import { clampReserve } from './cameraPresets';

/** A fresh orthographic camera sharing the perspective camera's depth range. */
export function makeOrthoCamera(near: number, far: number): THREE.OrthographicCamera {
  return new THREE.OrthographicCamera(-1, 1, 1, -1, near, far);
}

/**
 * Copy position and orientation from `src` to `dst` and refresh the world
 * matrix, so the inactive camera holds the same pose as the active one — a
 * projection switch then changes only the projection, never the framing.
 */
export function syncCameraPose(dst: THREE.Camera, src: THREE.Camera): void {
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.updateMatrixWorld(true);
}

/**
 * Fit the orthographic frustum to a sphere of `radius` at viewport `aspect`,
 * with the given depth range and edge padding. Leaves `camera.zoom` untouched —
 * OrbitControls owns zoom under an ortho camera, so this sets the framed
 * (zoom-1) extent and dolly rides on top.
 */
export function fitOrthoFrustum(
  camera: THREE.OrthographicCamera,
  radius: number,
  aspect: number,
  near: number,
  far: number,
  pad = 1.1,
): void {
  const { halfW, halfH } = orthoHalfExtents(radius, aspect, pad);
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.near = near;
  camera.far = far;
  camera.updateProjectionMatrix();
}

/**
 * Make the orthographic camera match the perspective master's current view: the
 * same pose, and a frustum whose vertical half-height equals `distance ×
 * tan(fov/2)` — the height the perspective camera spans at the orbit target.
 * That keeps the two projections framing the same thing, and lets the ONE set
 * of OrbitControls (which drive the perspective camera) drive ortho zoom for
 * free: dollying the perspective camera nearer shrinks the ortho frustum.
 *
 * `fov` is the perspective vertical field of view in degrees; `aspect` is
 * width / height, so the horizontal extent stretches by it.
 */
export function followPerspective(
  ortho: THREE.OrthographicCamera,
  persp: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
): void {
  syncCameraPose(ortho, persp);
  const dist = persp.position.distanceTo(target);
  const halfH = Math.max(dist * Math.tan((fovDeg * Math.PI) / 360), 1e-4);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  ortho.top = halfH;
  ortho.bottom = -halfH;
  ortho.right = halfH * a;
  ortho.left = -halfH * a;
  ortho.near = near;
  ortho.far = far;
  ortho.updateProjectionMatrix();
}

/**
 * Shift the projection window so the image moves up by `ndcY` (NDC units) on
 * both cameras, without moving either camera. Zero clears the shift. The
 * perspective camera's view offset carries its aspect as the full width,
 * because `setViewOffset` overwrites `aspect` with `fullWidth / fullHeight`.
 * Raycasting and `Vector3.project` read the projection matrix, so picking
 * follows the shift.
 */
export function setLensShift(
  persp: THREE.PerspectiveCamera,
  ortho: THREE.OrthographicCamera,
  ndcY: number,
): void {
  if (ndcY === 0) {
    persp.clearViewOffset();
    ortho.clearViewOffset();
    return;
  }
  const a = persp.aspect;
  persp.setViewOffset(a, 1, 0, ndcY / 2, a, 1);
  ortho.setViewOffset(1, 1, 0, ndcY / 2, 1, 1);
}

/**
 * The opening fit's lens shift, owned in one place so a resize can refit it
 * and a capture can clear it without racing a newer fit. Every change bumps a
 * generation; a capture restores its shift only if nothing changed meanwhile.
 */
export class LensShift {
  private _value = 0;
  private _generation = 0;
  /** True from an opening fit until a saved view, preset or standard view clears it. */
  private _fitted = false;

  private readonly _persp: () => THREE.PerspectiveCamera;
  private readonly _ortho: () => THREE.OrthographicCamera;

  constructor(persp: () => THREE.PerspectiveCamera, ortho: () => THREE.OrthographicCamera) {
    this._persp = persp;
    this._ortho = ortho;
  }

  get value(): number {
    return this._value;
  }

  /** The opening fit's shift; resizes keep refitting it until {@link clear}. */
  fit(ndcY: number): void {
    this._fitted = true;
    this._apply(ndcY);
  }

  /** Drop the shift for a pose that must stay centred; resizes leave it at 0. */
  clear(): void {
    this._fitted = false;
    this._apply(0);
  }

  /**
   * After a resize: an opening fit takes the new reserve share (0 while the bar
   * does not lay out, back to a band once it does) and the new aspect. A
   * cleared shift stays cleared, so a saved view or preset is never lifted.
   */
  refit(reserve: number): void {
    if (this._fitted) this._apply(clampReserve(reserve));
  }

  private _apply(ndcY: number): void {
    this._value = ndcY;
    this._generation++;
    setLensShift(this._persp(), this._ortho(), ndcY);
  }

  /** Run `capture` without the shift; put it back unless it changed meanwhile. */
  async without<T>(capture: () => Promise<T>): Promise<T> {
    const value = this._value;
    if (value === 0) return capture();
    setLensShift(this._persp(), this._ortho(), 0);
    const generation = this._generation;
    try {
      return await capture();
    } finally {
      if (this._generation === generation) setLensShift(this._persp(), this._ortho(), value);
    }
  }
}
