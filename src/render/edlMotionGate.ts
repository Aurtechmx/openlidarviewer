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
 * recent pointer/wheel/key input is still inside its render-holdover window
 * (`now < activityUntilMs`). This is the same motion signal the frame-rate
 * throttle uses, so EDL gating and full-rate rendering agree on "moving".
 */
export function cameraIsMoving(
  isTweening: boolean,
  now: number,
  activityUntilMs: number,
): boolean {
  return isTweening || now < activityUntilMs;
}

/**
 * Should the EDL post-process run this frame? Only when EDL is enabled AND the
 * camera is parked. When disabled, or while moving, the scene renders directly
 * (the zero-post-processing path).
 */
export function edlActiveThisFrame(edlEnabled: boolean, moving: boolean): boolean {
  return edlEnabled && !moving;
}
