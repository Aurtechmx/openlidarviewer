/**
 * convergenceExposure.ts
 *
 * Which image a viewer is shown while a parked camera is still accumulating,
 * for someone who has asked their system for less motion.
 *
 * Convergence contributes one temporal phase per frame until every phase has
 * been drawn. Presenting the history as it builds means the image visibly fills
 * in over those frames: a ramp, and on a sparse scan a pulsing one, since each
 * phase lands in a different subset of pixels. That is refinement rather than
 * movement, but a viewer who has asked for reduced motion did not ask to be
 * shown the difference between the two.
 *
 * So the accumulation still happens and the exposure of it does not. Under
 * reduced motion the direct rendering stays on screen for the whole sweep and
 * the accumulated result replaces it once, at convergence. The viewer gets the
 * quality without watching it arrive. Dropping accumulation instead would be
 * the cheaper reading of the preference and a worse deal: it answers a request
 * about motion by removing image quality, which is not what was asked for.
 *
 * One transition is what remains, and it is a content refinement rather than a
 * vestibular trigger — nothing translates, scales or flashes; a surface that was
 * grainy becomes less so. That is the honest limit of what this policy claims.
 *
 * The sweep cannot restart repeatedly on its own, which is what would turn one
 * transition into a flicker. Convergence requires a fully refined view, so it
 * needs a parked camera and a settled frontier, and an epoch change during the
 * sweep returns the state to idle where the direct rendering is already what is
 * shown. Reaching the swap twice in quick succession therefore takes a viewer
 * parking, moving and parking again, where the image changing is the thing they
 * just asked for.
 *
 * Takes the preference as a fact rather than reading `matchMedia` here, the
 * same way the lens takes source completeness rather than deciding it. This is
 * a pure policy: no DOM, no three.js, no media queries. The caller owns the
 * preference and the framebuffers.
 */
import type { ConvergenceState } from './convergence';
import { isConverged } from './convergence';

/** Which image the renderer should put on screen this frame. */
export type Exposure =
  /** The plain rendering of the samples present. */
  | 'direct'
  /** The accumulated history for the current epoch. */
  | 'accumulated';

/**
 * The image to present.
 *
 * Idle is `direct` under either preference and for the same reason rather than
 * as a shared default: idle means no history has been built for this epoch, so
 * there is nothing accumulated to show.
 */
export function exposureFor(state: ConvergenceState, reducedMotion: boolean): Exposure {
  if (state.kind === 'idle') return 'direct';
  if (isConverged(state)) return 'accumulated';
  return reducedMotion ? 'direct' : 'accumulated';
}

/**
 * Whether the renderer should keep contributing phases.
 *
 * Reduced motion changes what is shown, never what is computed. A viewer who
 * asked for less motion and a viewer who did not reach convergence on the same
 * frame, so the two see the same final image and one of them watched it build.
 * Tying the sweep to the preference would make the preference change the
 * result, which is the failure this separation exists to prevent.
 */
export function shouldAccumulate(state: ConvergenceState): boolean {
  return state.kind === 'converging';
}

/**
 * Whether this frame is the one where a reduced-motion viewer sees the image
 * change, given what the previous frame presented.
 *
 * For a caller that wants to cross-fade the single swap rather than cut it, and
 * for a test that wants to count transitions across a sweep and assert there
 * was exactly one.
 */
export function isExposureSwap(previous: Exposure, next: Exposure): boolean {
  return previous !== next;
}
