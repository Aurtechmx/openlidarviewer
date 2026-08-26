/**
 * frameProvenance.ts
 *
 * What a loaded cloud can say about the frame its coordinates came out of, in a
 * record small enough to keep beside the cloud for its whole life.
 *
 * `spatialFrame.ts` performs the conversion. It deliberately refuses to decide
 * that a source is geocentric, because nothing in a coordinate says so. This
 * module holds the ANSWER a reader established from what its format declared,
 * so the rest of the app reads one statement instead of re-deriving a guess per
 * surface.
 *
 * Three fields carry the weight:
 *
 *   basis                what the render coordinates are, and how up is defined;
 *   anchor               the source coordinate render zero was taken about, so
 *                        the conversion is reversible rather than merely applied;
 *   verticalReference    what a height in this cloud is measured from.
 *
 * UNKNOWN IS A VALUE, NOT AN ABSENT ONE. A reader that could not establish the
 * frame records `unknown` and a vertical reference of `unknown`, and every
 * consumer of a height can then refuse rather than average a rotation that was
 * never applied into a slope. A record that was simply missing would be read as
 * "nobody asked yet", which is a different fact.
 *
 * THE UNIT SURVIVES AN UNRESOLVED FRAME. Whether the frame is known and what
 * the linear unit is are separate questions, and a format that establishes
 * metres for linear distances has established them whether or not its frame is
 * resolved. Dropping the unit alongside the frame would lose a fact the source
 * actually stated.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

import type { CrsLinearUnit } from '../../io/crs';
import type { VerticalReference } from '../height';
import type { Vec3 } from './spatialFrame';

/**
 * What the render coordinates of a cloud are.
 *
 * `local-enu`   — rotated into an east-north-up frame tangent to the WGS84
 *                 ellipsoid beneath {@link CloudFrameProvenance.anchor}, so
 *                 render +Z is local up and a height is a height.
 * `unknown`     — the source's own axes, recentred and not rotated, with no
 *                 established statement of which way is up.
 */
export type CloudFrameBasis = 'local-enu' | 'unknown';

/** What a cloud can say about the frame it is drawn in. */
export interface CloudFrameProvenance {
  readonly basis: CloudFrameBasis;
  /**
   * The declaration the basis was established from, verbatim enough to audit.
   * `null` when no declaration was found, which is the only reason a basis is
   * `unknown`: it is never a failure to apply a basis that was established.
   */
  readonly declaredBy: string | null;
  /**
   * The source coordinate render zero was taken about, present only for a
   * resolved basis. With it, the frame that produced the cloud can be rebuilt
   * and a render coordinate carried back to the source frame exactly.
   */
  readonly anchor?: Vec3;
  readonly verticalReference: VerticalReference;
  /** Linear unit of the render coordinates. Independent of the basis. */
  readonly linearUnit: CrsLinearUnit;
}

/**
 * Whether a height, slope or terrain derivative taken from this cloud is
 * measured along a known up.
 *
 * The question is asked of the BASIS, not of the anchor: a recentred cloud has
 * an origin and still has no established up, and reading the presence of an
 * origin as permission is exactly the confusion this record exists to end.
 */
export function frameHasVerticalMeaning(p: CloudFrameProvenance): boolean {
  return p.basis === 'local-enu' && p.verticalReference !== 'unknown';
}

/**
 * One line naming the basis, the vertical reference and the unit, in the order
 * a reader needs them: what the axes are, what a height is measured from, and
 * what the numbers are counted in.
 */
export function describeCloudFrame(p: CloudFrameProvenance): string {
  const basis =
    p.basis === 'local-enu' ? 'Local east-north-up' : 'Frame not established';
  const vertical =
    p.verticalReference === 'ellipsoidal'
      ? 'ellipsoidal height'
      : p.verticalReference === 'unknown'
        ? 'no vertical reference'
        : `${p.verticalReference} height`;
  const unit = p.linearUnit === 'unknown' ? 'unit unknown' : `${p.linearUnit}s`;
  return `${basis}, ${vertical}, ${unit}`;
}

/**
 * What an unestablished frame means for anything measured up the Z axis.
 *
 * Stated as a consequence rather than as a status, because the scene looks
 * correct either way: a cloud whose axes were never rotated into a tangent
 * frame fits the camera and draws exactly as a levelled one does, and the only
 * visible difference is in the numbers read off it.
 */
export const FRAME_UNKNOWN_NOTE =
  'This source declares no coordinate frame, so which way is up is not ' +
  'established. Heights, slopes and terrain derivatives taken from it are ' +
  'measured along an axis that may not be vertical.';
