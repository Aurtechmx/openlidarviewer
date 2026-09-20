/**
 * evidenceLens.ts
 *
 * The region under the cursor where the renderer stops reconstructing and shows
 * what was actually measured.
 *
 * The Continuity Field fills gaps between samples so a surface reads as a
 * surface. That is a presentation choice, and it puts pixels on screen that no
 * point was recorded at. The lens is how a viewer checks: inside it nothing is
 * substituted, so whatever remains is coverage the data paid for.
 *
 * The edge is where this gets decided rather than decorated. A lens that faded
 * reconstruction in across its rim would produce a ring of pixels that are
 * partly invented, and a viewer holding the lens over a suspicious patch would
 * be reading exactly the band that cannot answer the question. So the evidence
 * decision is hard: a pixel is either inside the lens and unreconstructed, or
 * outside it and subject to the field. `coverage` softens how the two sides are
 * blended visually; it never softens whether a pixel is allowed to be invented.
 *
 * Pure: no three.js, no DOM, no pointer events. The caller owns the cursor and
 * the framebuffer.
 *
 * Presentation only, and this one is load-bearing. Picking, snapping and every
 * measurement read the same authoritative points whether the lens is open or
 * shut. The lens changes what is drawn, never what is measured, so nothing here
 * takes or returns a coordinate that anything could measure with.
 */

/**
 * What the lens is able to show, which is not always what a viewer will read
 * into it.
 *
 * Under the lens nothing is substituted, so every pixel left is one a sample
 * paid for. On a streamed scan that sentence is still true and still
 * misleading: the samples present are the ones that have loaded, not the ones
 * the file holds, and a viewer holding the lens over a thin patch cannot tell
 * whether the ground was sparsely measured or the data has not arrived. Those
 * are opposite conclusions and the lens looks identical in both.
 *
 * So the lens carries the same qualifier a measurement does, from the same
 * fact. It can report complete evidence only where the source is proven
 * complete, and never on its own say.
 */
export type LensEvidence =
  /** Every sample the source holds for this view is present. */
  | 'complete'
  /** Some of the source is not here yet; absence is not evidence of absence. */
  | 'partial';

/**
 * What the lens may claim, given whether the source is proven complete.
 *
 * Takes the fact rather than deriving it, because completeness is a property of
 * the source and is decided where residency is known. A lens that worked it out
 * for itself would be a second opinion on a question that already has an owner.
 */
export function lensEvidence(sourceComplete: boolean): LensEvidence {
  return sourceComplete === true ? 'complete' : 'partial';
}

/** The lens as the renderer holds it. */
export interface Lens {
  /** Cursor position in device pixels. */
  readonly centreXPx: number;
  readonly centreYPx: number;
  /** Radius of the fully raw region, in device pixels. */
  readonly radiusPx: number;
  /** Width of the visual blend outside that radius, in device pixels. */
  readonly featherPx: number;
  /** Whether the lens is open at all. */
  readonly enabled: boolean;
}

/** A closed lens. Nothing is revealed and the field renders everywhere. */
export const LENS_CLOSED: Lens = {
  centreXPx: 0,
  centreYPx: 0,
  radiusPx: 0,
  featherPx: 0,
  enabled: false,
};

/**
 * How strongly a pixel is blended toward the raw rendering, in `[0, 1]`.
 *
 * 1 inside the radius, falling to 0 across the feather. This drives appearance
 * only. Whether a pixel may be reconstructed is {@link insideLens}, which does
 * not interpolate.
 */
export function lensCoverage(xPx: number, yPx: number, lens: Lens): number {
  if (!lens.enabled) return 0;
  if (!(lens.radiusPx > 0)) return 0;
  const dx = xPx - lens.centreXPx;
  const dy = yPx - lens.centreYPx;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= lens.radiusPx) return 1;
  const feather = lens.featherPx;
  if (!(feather > 0)) return 0;
  const t = (d - lens.radiusPx) / feather;
  if (t >= 1) return 0;
  // Smoothstep, so the rim has no visible banding where it meets the field.
  const u = 1 - t;
  return u * u * (3 - 2 * u);
}

/**
 * Whether a pixel is under the lens, and so must show measured evidence only.
 *
 * Deliberately not a function of {@link lensCoverage}. A pixel anywhere in the
 * feather is still a pixel the viewer is looking through the lens at, so it is
 * held to the same rule as the centre. Reconstruction stops at the outer edge of
 * the feather, not at the radius, which errs toward showing less than the field
 * would rather than more.
 */
export function insideLens(xPx: number, yPx: number, lens: Lens): boolean {
  if (!lens.enabled) return false;
  if (!(lens.radiusPx > 0)) return false;
  const dx = xPx - lens.centreXPx;
  const dy = yPx - lens.centreYPx;
  const reach = lens.radiusPx + Math.max(0, lens.featherPx);
  return dx * dx + dy * dy <= reach * reach;
}

/**
 * Whether a reconstructed pixel may be substituted at this position.
 *
 * The one rule the lens exists to enforce: under the lens, nothing invented is
 * shown.
 */
export function admitsReconstruction(xPx: number, yPx: number, lens: Lens): boolean {
  return !insideLens(xPx, yPx, lens);
}
