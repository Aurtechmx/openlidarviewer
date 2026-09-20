/**
 * withheldPolicy.ts — what a Withheld point is for, in each of the three
 * things this application does with points.
 *
 * ASPRS gives the bit one meaning: the producer marked this point as one that
 * should not be used. It does not say deleted, and it does not say wrong. The
 * point is still in the file, still has a position, and a viewer inspecting
 * the scan is entitled to see it.
 *
 * Three contexts and three answers:
 *
 *   raw inspection        show it, marked as what it is
 *   source export         write it back, bit intact
 *   scientific processing exclude it, unless the caller asked for it
 *
 * The third is the only one that removes anything, and it removes nothing from
 * the data: it decides which points a computation reads. A terrain surface
 * fitted through points the producer marked as not-to-be-used is a surface
 * nobody sanctioned, and the honest default is to leave them out and say so.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It never excludes Overlap. Overlap marks a point in the seam between two
 * flight lines, which is a statement about coverage rather than about the
 * point: the ground under an overlap is measured twice, not badly. A processor
 * that dropped overlap globally would thin every seam in the survey and change
 * the density of exactly the strips where two passes agree.
 *
 * It never reinterprets a classification code. The code and the flags are
 * separate fields and stay separate: nothing here maps a class to another
 * class, and the only thing it reads is the flag byte. `lasSemantics` owns
 * what the bits mean and this imports that rather than restating it, so a
 * format whose flags move cannot leave two answers in the tree.
 *
 * ── THE STATE OF THE TREE ───────────────────────────────────────────────────
 * Nothing calls this yet, and that is the audit rather than an omission. No
 * scientific path in this repository consults the Withheld bit: terrain,
 * density, the ground filter, stockpile volumes, contours, profiles, the
 * classifier, registration and change, and measurement all read every point
 * the cloud holds. The bit survives the whole pipeline, from the decoder
 * through `PointCloud.classificationFlags` to the LAS writer, so applying this
 * policy is a matter of consulting something already there.
 *
 * Applying it would move measured numbers. Every product listed above would
 * change on any scan that marks a single point, and several of them carry
 * claims with recorded evidence. So the policy is written down first and
 * applied as its own change, with its own before-and-after on real data.
 *
 * Pure: no DOM, no GPU, no cloud. Flags in, decisions out.
 */
import { decodeExtendedClassificationFlags } from '../lasSemantics';

/** What the points are being used for. */
export type ProcessingContext =
  /** A person looking at the scan, or a readout under the cursor. */
  | 'raw-inspection'
  /** Writing the source back out, in LAS or LAZ. */
  | 'source-export'
  /** Computing a product: a surface, a volume, a contour, a statistic. */
  | 'scientific-processing';

/** What happens to a Withheld point. */
export type WithheldTreatment =
  /** It is kept, and where it is shown it is marked. */
  | 'preserve'
  /** It is left out of the computation. The data is untouched. */
  | 'exclude';

/**
 * How this context treats a Withheld point.
 *
 * `includeWithheld` is the caller saying it wants them anyway, which only
 * scientific processing has a use for: a person auditing what the producer
 * rejected, or a comparison that needs the full set. Inspection and export
 * preserve regardless, so the argument cannot turn either of them into an
 * exclusion. A flag that could delete points from an export would be a way to
 * lose data by mistake.
 */
export function withheldTreatment(
  context: ProcessingContext,
  includeWithheld = false,
): WithheldTreatment {
  if (context !== 'scientific-processing') return 'preserve';
  return includeWithheld ? 'preserve' : 'exclude';
}

/** Whether this context leaves Withheld points out of what it reads. */
export function excludesWithheld(context: ProcessingContext, includeWithheld = false): boolean {
  return withheldTreatment(context, includeWithheld) === 'exclude';
}

/**
 * Whether one point is marked Withheld.
 *
 * The byte is the normalised flag layout the decoder produces for every
 * format, and what its bits mean belongs to `lasSemantics`, so this decodes
 * through it rather than testing a bit of its own.
 */
export function isWithheld(flagsByte: number): boolean {
  if (!Number.isFinite(flagsByte)) return false;
  return decodeExtendedClassificationFlags(flagsByte).withheld;
}

/**
 * Whether one point may be read in this context.
 *
 * The only question this module answers about an individual point. Overlap,
 * synthetic and key-point markings are not consulted: a point carrying any of
 * them is read exactly as one carrying none.
 */
export function pointIsReadable(
  flagsByte: number,
  context: ProcessingContext,
  includeWithheld = false,
): boolean {
  if (!excludesWithheld(context, includeWithheld)) return true;
  return !isWithheld(flagsByte);
}

/**
 * How many of a run of points a context would leave out.
 *
 * For a caller that wants to state the size of the exclusion before it makes
 * it, which a product that reports what it read should. A context that
 * excludes nothing counts nothing rather than walking the array.
 */
export function withheldCount(
  flags: ArrayLike<number> | null | undefined,
  context: ProcessingContext = 'scientific-processing',
  includeWithheld = false,
): number {
  if (!flags || !excludesWithheld(context, includeWithheld)) return 0;
  let n = 0;
  for (let i = 0; i < flags.length; i++) if (isWithheld(flags[i])) n += 1;
  return n;
}
