/**
 * microGap.ts
 *
 * Whether a pixel with no sample of its own may borrow one from its immediate
 * neighbours, and at what depth.
 *
 * A point cloud drawn as sprites leaves single-pixel holes between samples of a
 * surface that is genuinely continuous. Closing those reads as a solid surface
 * instead of a screen door. The risk is the same operation applied one pixel
 * further: a gap that is not a sampling artefact but the actual absence of data,
 * filled in and presented as if something had been measured there.
 *
 * Three rules keep the two apart.
 *
 * A pixel that already carries a sample is never touched, so nothing measured is
 * blurred by this pass.
 *
 * A gap is only closed when neighbours on opposite sides agree, either left with
 * right or above with below, or when three of the four cardinals support it. One
 * neighbour, or two adjacent ones, is a corner or an edge rather than a surface
 * spanning the hole.
 *
 * Every supporting neighbour must lie on one surface, judged by the depth rule
 * the accumulation pass already uses. Neighbours at different depths mean the
 * pixel sits on a silhouette, a roof edge or a foreground against a background,
 * and filling it would weld two surfaces that are not touching.
 *
 * A reconstructed pixel never supports another reconstruction. Without that,
 * each pass would seed the next and a fill would creep outward across sparse
 * geometry, one pixel at a time, until a hole in the data had become a surface.
 * Support must trace back to a sample in every case.
 *
 * Pure: no three.js, no GPU, no framebuffer. The caller owns the pixels and
 * performs the write. Display only. A reconstructed pixel is not a measurement,
 * it is marked as reconstructed so it can be told apart, and nothing derived
 * from it may reach picking, measurement, terrain, export or claim evidence.
 */
import { depthCompatible, DEFAULT_DEPTH_EPSILON } from './depthMerge';

/** Where a pixel's colour came from. */
export type SupportKind =
  /** Nothing has been drawn here. */
  | 'none'
  /** A source sample was rasterised here. */
  | 'direct'
  /** Built up from source samples across several frames of one epoch. */
  | 'accumulated'
  /** Borrowed from neighbours by this pass. Never evidence for another fill. */
  | 'reconstructed';

/** One cardinal neighbour of the candidate pixel. */
export interface Neighbour {
  readonly depth: number;
  readonly support: SupportKind;
}

/** The four cardinal neighbours, in the order the opposite-pair rule reads them. */
export interface Cardinals {
  readonly left: Neighbour;
  readonly right: Neighbour;
  readonly up: Neighbour;
  readonly down: Neighbour;
}

/** Why a gap was left alone, for diagnostics and the evidence lens. */
export type RefusedReason =
  /** The pixel already carries a sample. */
  | 'occupied'
  /** Too few neighbours, or only adjacent ones: a corner, not a surface. */
  | 'unsupported'
  /** Supporting neighbours sit at different depths: an edge, not a gap. */
  | 'discontinuity';

/** The outcome for one candidate pixel. */
export type FillDecision =
  | { readonly fill: false; readonly reason: RefusedReason }
  | { readonly fill: true; readonly depth: number; readonly support: 'reconstructed' };

/** Whether a neighbour may be counted as evidence for a fill. */
function isEvidence(n: Neighbour): boolean {
  if (n.support !== 'direct' && n.support !== 'accumulated') return false;
  return n.depth > 0 && Number.isFinite(n.depth);
}

/**
 * Whether a background pixel should be filled, and at what depth.
 *
 * The fill depth is the nearest supporting neighbour rather than their mean. The
 * neighbours already agree to within the depth tolerance, so the choice barely
 * moves the value, and taking the nearest keeps a filled pixel from sitting
 * behind the surface it belongs to and being overwritten by it later.
 */
export function shouldFill(
  centre: SupportKind,
  cardinals: Cardinals,
  epsilon: number = DEFAULT_DEPTH_EPSILON,
): FillDecision {
  if (centre !== 'none') return { fill: false, reason: 'occupied' };

  const { left, right, up, down } = cardinals;
  const horizontal = isEvidence(left) && isEvidence(right);
  const vertical = isEvidence(up) && isEvidence(down);
  const supporting = [left, right, up, down].filter(isEvidence);
  if (!horizontal && !vertical && supporting.length < 3) {
    return { fill: false, reason: 'unsupported' };
  }

  // One surface, not two that happen to bracket the pixel. Compared pairwise so
  // a chain of individually-close neighbours cannot span an arbitrary depth.
  for (let i = 0; i < supporting.length; i++) {
    for (let j = i + 1; j < supporting.length; j++) {
      if (!depthCompatible(supporting[i].depth, supporting[j].depth, epsilon)) {
        return { fill: false, reason: 'discontinuity' };
      }
    }
  }

  let depth = supporting[0].depth;
  for (const n of supporting) if (n.depth < depth) depth = n.depth;
  return { fill: true, depth, support: 'reconstructed' };
}
