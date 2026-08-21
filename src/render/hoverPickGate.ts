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
 * `userInteracting` covers an OrbitControls drag, which is the only gesture that
 * sets it. Walk, fly, the custom orbit drag and the hand-pan drag all bypass
 * OrbitControls, so `navigating` carries those: without it the gate stays open
 * and a pick runs on every pointer-move frame while the camera is being driven.
 * That pick scans every point in every visible cloud, so on a multi-million-point
 * scan it costs milliseconds per frame for a readout the user is not reading. In
 * walk and fly the readout is stale as well as expensive, because a locked
 * pointer reports the position it was locked at rather than where the cursor is.
 */

/**
 * Should the hover/probe pick run this frame? Yes, unless the user is actively
 * interacting (e.g. dragging to orbit/pan), the camera is tweening, or the
 * camera is being driven by a mode OrbitControls does not report.
 *
 * `navigating` is optional so a caller that only has the OrbitControls flag
 * keeps its existing behaviour; omitting it reads as "not navigating".
 */
export function shouldRunProbePick(state: {
  userInteracting: boolean;
  tweening: boolean;
  navigating?: boolean;
}): boolean {
  return !(state.userInteracting || state.tweening || state.navigating === true);
}
