/**
 * lensPresentation.ts — what a viewer sees under the evidence lens.
 *
 * The lens answers one question: what is actually there. Everywhere else the
 * renderer may close a sampling gap; under the lens it may not, so what is
 * left is what a sample paid for.
 *
 * `evidenceLens` owns the geometry of that, `lensPlacement` owns where the
 * lens goes and what opens or closes it. This module owns the two rules that
 * sit between them and the frame: which pixels may be substituted, and what a
 * pixel that was already substituted looks like once the lens arrives over it.
 *
 * ── THE FEATHER IS OPACITY AND NOTHING ELSE ─────────────────────────────────
 * A lens with a hard edge reads as a cut-out, so the field fades back in
 * across a feather. That fade is a number between 0 and 1, and the single
 * thing it must never do is decide anything: a pixel at 0.4 through the
 * feather is still a pixel the viewer is looking through the lens at, and
 * showing it four-tenths reconstructed would be a reconstruction the lens was
 * supposed to have refused.
 *
 * So the two answers come from two functions with different shapes.
 * {@link admitsReconstruction} returns a boolean and reads `insideLens`, which
 * does not interpolate and whose reach includes the whole feather.
 * {@link lensOpacity} returns the fraction and is used for blending. Nothing
 * here passes the fraction into a decision, and a test reads the source to
 * check that the admission path never calls the blend.
 *
 * ── WHAT AN ALREADY-FILLED PIXEL BECOMES ────────────────────────────────────
 * A pixel reconstructed before the lens moved over it does not become
 * measured by being looked at. Under the lens it is shown as what it is,
 * nothing, which is the gap the fill was covering. That is a read-time
 * substitution and never a write: the support surface keeps the record that
 * the pixel was reconstructed, because a lens is a way of looking rather than
 * an edit.
 *
 * Accumulated pixels stay. They were built from source samples across a sweep,
 * which is what the lens is for showing, and hiding them would leave the lens
 * displaying less evidence than exists.
 *
 * ── PICKING ─────────────────────────────────────────────────────────────────
 * There is no picking here and there is nothing to add. A click resolves
 * against the source points, so a reconstructed pixel was never pickable and
 * the lens does not have to make it so. Anything in this file that claimed to
 * change what a click hits would be a second picking path.
 *
 * Pure: no GPU, no DOM, no three.js. Display only, and nothing here may reach
 * picking, measurement, terrain, export or claim evidence.
 */
import { admitsReconstruction, insideLens, lensCoverage, type Lens } from './evidenceLens';
import type { SupportKind } from './microGap';

/**
 * How strongly a pixel is shown as raw rather than as field, in `[0, 1]`.
 *
 * 1 at the centre, falling across the feather to 0 outside. Appearance only:
 * a caller blends with it and decides nothing from it.
 */
export function lensOpacity(xPx: number, yPx: number, lens: Lens): number {
  return lensCoverage(xPx, yPx, lens);
}

/**
 * Whether the gap pass may substitute a pixel at this position.
 *
 * A boolean from a boolean. The whole feather counts as inside, so
 * reconstruction stops at the outer edge rather than at the radius, which errs
 * toward showing less than the field would rather than more.
 */
export function mayReconstructAt(xPx: number, yPx: number, lens: Lens): boolean {
  return admitsReconstruction(xPx, yPx, lens);
}

/**
 * The provenance a pixel is DISPLAYED as, which is not always the one it has.
 *
 * Under the lens a reconstructed pixel shows as nothing, because it is
 * nothing: the fill was covering a gap and the lens is the viewer asking to
 * see the gap. Everywhere else, and for every other state, the displayed
 * provenance is the stored one.
 *
 * The stored value is untouched. A lens is a way of looking, and a frame drawn
 * without it must show the same pixels it showed before the lens opened.
 */
export function shownSupport(kind: SupportKind, underLens: boolean): SupportKind {
  return underLens && kind === 'reconstructed' ? 'none' : kind;
}

/** The displayed provenance for a pixel at a position. */
export function shownSupportAt(
  kind: SupportKind,
  xPx: number,
  yPx: number,
  lens: Lens,
): SupportKind {
  return shownSupport(kind, insideLens(xPx, yPx, lens));
}
