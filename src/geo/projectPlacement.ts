/**
 * projectPlacement.ts — plan how a layer joins a project's CRS frame.
 *
 * The multi-layer mount places layers that already share a proven CRS; it flags
 * a mismatched CRS and never reprojects. A cross-CRS project instead names one
 * project CRS and asks each layer to enter it. The reprojection engine already
 * exists (`reprojectGlobal`, proj4-backed) but runs only in the export path.
 *
 * This plans the placement and keeps OLV's epistemic distinction intact:
 * horizontal reprojection between two known projected CRSs is supported; a layer
 * with no CRS cannot be auto-placed and needs registration; and vertical
 * comparability is separate — reprojection moves X/Y only, so height and change
 * claims are allowed ONLY when both vertical datums are resolved, otherwise the
 * layer mounts in X/Y with height claims withheld. Pure planning; the actual
 * point transform delegates to `reprojectGlobal`.
 */

import type { GlobalPoints } from '../convert/globalPoints';
import { reprojectGlobal, type ReprojectResult } from '../convert/reproject';
import type { SpatialContext } from './SpatialContext';
import { compareSpatialFrames, type FrameCompatibility } from './frameCompatibility';

export type HorizontalPlacement = 'identity' | 'reproject' | 'needs-registration';

export interface PlacementInputs {
  /** The layer's horizontal EPSG, or null when it declares no CRS. */
  readonly layerEpsg: number | null;
  /** The project's horizontal EPSG, or null when no project CRS is set. */
  readonly projectEpsg: number | null;
  /** The layer's frame, read for its vertical reference and vertical unit. */
  readonly layerFrame: SpatialContext;
  /** The project's frame, read the same way. */
  readonly projectFrame: SpatialContext;
}

export interface PlacementPlan {
  readonly horizontal: HorizontalPlacement;
  /** True only when height/change claims are defensible (both vertical datums resolved). */
  readonly verticalComparable: boolean;
  readonly reasonCode: string;
  readonly reason: string;
}

/**
 * Why heights are withheld, in the words the frame comparison already used.
 * Restating the reason here would let the two drift, and the note a user reads
 * would stop matching the evidence the verdict was made on.
 */
function verticalWithheldNote(vertical: FrameCompatibility): string {
  const stated = vertical.notes.find((n) => n.startsWith('Vertical'));
  return (
    stated ??
    'Heights are not on a confirmed common reference, so height and change claims are withheld.'
  );
}

/** Decide how a layer enters the project frame, without moving any points. */
export function planPlacement(inp: PlacementInputs): PlacementPlan {
  // Delegated rather than decided here. Two vertical datums can both be
  // resolved and still not be comparable: NAVD88 in feet and EGM2008 in metres
  // are each fully declared, sit on different surfaces, and carry different
  // unit scales. `compareSpatialFrames` already weighs reference identity and
  // unit scale together, and a second opinion on the same question is a second
  // answer to maintain.
  const vertical = compareSpatialFrames(inp.layerFrame, inp.projectFrame);
  const verticalComparable = vertical.verticalComparable;
  const vNote = verticalComparable ? '' : ` ${verticalWithheldNote(vertical)}`;

  if (inp.projectEpsg == null) {
    return {
      horizontal: 'needs-registration',
      verticalComparable: false,
      reasonCode: 'NO_PROJECT_CRS',
      reason: 'The project has no CRS, so a layer cannot be reprojected into one.',
    };
  }
  if (inp.layerEpsg == null) {
    return {
      horizontal: 'needs-registration',
      verticalComparable: false,
      reasonCode: 'LAYER_NO_CRS',
      reason: 'The layer declares no CRS, so it cannot be auto-placed; align it with tie-point registration instead.',
    };
  }
  if (inp.layerEpsg === inp.projectEpsg) {
    return {
      horizontal: 'identity',
      verticalComparable,
      reasonCode: 'SAME_CRS',
      reason: `The layer is already in the project CRS (EPSG:${inp.projectEpsg}).${vNote}`,
    };
  }
  return {
    horizontal: 'reproject',
    verticalComparable,
    reasonCode: 'REPROJECT',
    reason: `Reproject the layer from EPSG:${inp.layerEpsg} into the project EPSG:${inp.projectEpsg}.${vNote}`,
  };
}

/**
 * Reproject a layer's points into the project CRS. Only the horizontal (X/Y)
 * coordinates move; Z is carried through unchanged by `reprojectGlobal`, which
 * is why the plan gates height claims on vertical resolution separately.
 */
export function placeInProject(
  g: GlobalPoints,
  layerEpsg: number,
  projectEpsg: number,
): ReprojectResult {
  return reprojectGlobal(g, layerEpsg, projectEpsg);
}
