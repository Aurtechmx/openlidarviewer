/**
 * hoverPickGate.ts  (v0.6 P6 — hover/probe pick gate)
 *
 * The live probe raycasts the point cloud under the cursor to read out the
 * hovered point. That pick is worth doing on an ordinary hover, but pointless —
 * and a waste of a raycast — while the user is actively dragging the camera or
 * while a camera tween is animating: the readout would just be chasing a moving
 * scene the user isn't reading.
 *
 * This is the whole gate, kept as one pure predicate (no DOM, no three.js) so it
 * is unit-tested directly; Viewer owns the userInteracting / tweening flags.
 *
 * IMPORTANT: gate on discrete states only, never on a debounced `moving` flag
 * (the kind that stays true for a holdover window after the last pointer event):
 * that holdover would keep firing after an ordinary hover move and freeze the
 * live probe readout during exactly the plain hovering this pick exists to
 * serve.
 *
 * `userInteracting` must report EVERY way the camera is being driven, not just
 * an OrbitControls drag. Walk, fly, the custom orbit drag and the hand-pan drag
 * all bypass OrbitControls, and a caller that forwards only the OrbitControls
 * flag leaves the gate open through all four: a pick then runs on every
 * pointer-move frame, scanning every point of every visible cloud for a readout
 * nobody is reading. `NavController.isDriving` carries the other four; the
 * Viewer folds it in. In walk and fly the readout is stale as well as
 * expensive, because a locked pointer reports the position it was locked at.
 */

/**
 * Should the hover/probe pick run this frame? Yes, unless the user is driving
 * the camera or a camera tween is animating.
 */
export function shouldRunProbePick(state: {
  userInteracting: boolean;
  tweening: boolean;
}): boolean {
  return !(state.userInteracting || state.tweening);
}
