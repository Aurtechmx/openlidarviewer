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
 * IMPORTANT: gate on `userInteracting` / `tweening` only — the discrete states
 * of "the user is dragging" and "a tween is running". Do NOT gate on a debounced
 * `moving` flag (the kind that stays true for a holdover window after the last
 * pointer event): that holdover would keep firing after an ordinary hover move
 * and freeze the live probe readout during exactly the plain hovering this pick
 * exists to serve.
 */

/**
 * Should the hover/probe pick run this frame? Yes, unless the user is actively
 * interacting (e.g. dragging to orbit/pan) or the camera is tweening.
 */
export function shouldRunProbePick(state: {
  userInteracting: boolean;
  tweening: boolean;
}): boolean {
  return !(state.userInteracting || state.tweening);
}
