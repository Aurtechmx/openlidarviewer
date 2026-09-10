/**
 * edlMotionGate.ts
 *
 * The pure decision behind "suspend EDL while the camera is moving". EDL
 * (Eye-Dome Lighting) is a full-screen post-process that runs on every rendered
 * frame; during navigation every frame is rendered, so its cost lands
 * continuously and makes orbit/pan/fly judder. Dropping it while the camera
 * moves — and snapping it back the instant the view is parked — removes that
 * per-frame cost exactly when it hurts, with no change to the at-rest look.
 *
 * Kept here as tiny pure predicates (no three.js, no DOM) so the gating logic
 * is unit-tested directly; the render loop in Viewer owns the stateful
 * snap-back-once-settled bookkeeping.
 */

/**
 * Is the camera moving this frame? True while a camera tween animates, or while
 * camera input is still inside its holdover window (`now < cameraUntilMs`).
 *
 * The deadline is the CAMERA one, which only OrbitControls' 'change' extends —
 * not the render deadline, which every input extends. The two were one signal,
 * so hovering a stationary cloud read as motion: EDL cut out and the pixel
 * ratio dropped for the holdover, then both snapped back, which is the
 * brightness pop on hover.
 */
export function cameraIsMoving(
  isTweening: boolean,
  now: number,
  cameraUntilMs: number,
): boolean {
  return isTweening || now < cameraUntilMs;
}

/**
 * Should the EDL post-process run this frame? Only when EDL is enabled AND the
 * camera is parked. When disabled, or while moving, the scene renders directly
 * (the zero-post-processing path).
 */
export function edlActiveThisFrame(edlEnabled: boolean, moving: boolean): boolean {
  return edlEnabled && !moving;
}
