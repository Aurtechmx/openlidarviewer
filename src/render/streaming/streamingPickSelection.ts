/**
 * streamingPickSelection.ts
 *
 * Pure, three.js-free selection helper for picking against a set of resident
 * streaming nodes. Streaming pick-selection — the algorithm that decides which
 * streaming-node point a click lands on, and whether deeper refinement is
 * still pending for the picked node, is testable here in isolation from the
 * Viewer's mesh-lifecycle plumbing.
 *
 * Invariants enforced by this module (the hardening contract):
 *
 *   1. **Resident-only picks.** The caller is responsible for filtering to
 *      visible, resident nodes before calling `selectStreamingPick`. This
 *      module never sees a stale entry — that defence lives in the Viewer's
 *      pick loop (mesh-still-in-scene + map-still-paired checks) and is
 *      proven by the pick-prune test in `tests/streamingPicking.test.ts`.
 *
 *   2. **Angular-miss fairness.** Selection minimises perpendicular offset
 *      divided by distance along the ray, so a near point and a far point
 *      are judged by the same screen-space yardstick.
 *
 *   3. **Refinement consistency.** When the picked point came from a node
 *      shallower than the deepest currently-resident node, the result's
 *      `streamingRefining` flag is true — the inspector / probe surface this
 *      so the user knows a deeper sibling may snap in shortly.
 *
 *   4. **No silent stale picks.** If the caller hands an empty list, the
 *      result is `null`; the consumer treats that as "no pick", never as
 *      "still the previous pick". Combined with the Viewer-side prune-on-
 *      sighting behaviour, a click against an evicted node returns null
 *      rather than a position from the freed buffer.
 *
 * Used by `Viewer._pickStreamingDetailed`. The Viewer hands a pre-filtered
 * list of `{ positions, depth }` records (one per resident, visible node)
 * plus the ray; this returns the best hit + the refinement flag.
 */

import { nearestPointAlongRay, type Vec3 } from '../navMath';

/**
 * One resident streaming node's contribution to the pick pass — its decoded
 * position buffer and the octree depth of the node it came from. The Viewer
 * adds these in lockstep with `addStreamingMesh` and prunes them in lockstep
 * with `removeStreamingMesh`, so the pure selection algorithm here never
 * sees an entry that has been evicted from the scene.
 */
export interface StreamingPickNode {
  /** Interleaved xyz positions in render-space coordinates. */
  positions: Float32Array;
  /** Octree depth — used to flag refinement when a shallower node wins. */
  depth: number;
}

/** The result of `selectStreamingPick` when a node was hit. */
export interface StreamingPickHit {
  /** Index of the winning node within the input array. */
  nodeIndex: number;
  /** Index of the winning point within that node's `positions`. */
  pointIndex: number;
  /** The winning point's xyz coordinates. */
  point: Vec3;
  /**
   * True when the picked node's depth is less than the deepest currently-
   * resident depth — a hint to the user that a deeper sibling is still
   * loading, so the pick may refine momentarily. False when the picked node
   * IS at the deepest resident depth, or when only one depth is resident.
   */
  streamingRefining: boolean;
}

/**
 * The same on-target threshold the Viewer's static-cloud pick uses: angular
 * miss (offset / along the ray) must be under this to accept a hit. Roughly
 * "~within 4° on screen". Centralised here so the two pick paths stay in
 * lockstep — a regression in one is mechanically prevented from drifting
 * out of step with the other.
 */
export const STREAMING_PICK_ANGULAR_TOLERANCE = 0.07;

/**
 * Pure selection: among the resident node entries, return the best on-target
 * hit (or null if none clears the angular tolerance), plus the
 * `streamingRefining` hint.
 *
 * The caller must have already filtered `nodes` down to visible + resident
 * entries (this module makes no assumptions about visibility — that lives in
 * the Viewer's pick loop along with the mesh-parent check).
 */
export function selectStreamingPick(
  nodes: readonly StreamingPickNode[],
  origin: Vec3,
  direction: Vec3,
): StreamingPickHit | null {
  if (nodes.length === 0) return null;

  let best:
    | { nodeIndex: number; pointIndex: number; point: Vec3; depth: number; score: number }
    | null = null;
  let maxResidentDepth = -1;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.depth > maxResidentDepth) maxResidentDepth = node.depth;
    const hit = nearestPointAlongRay(node.positions, origin, direction);
    if (!hit) continue;
    const score = hit.offset / hit.along;
    if (score >= STREAMING_PICK_ANGULAR_TOLERANCE) continue;
    if (best !== null && score >= best.score) continue;
    best = {
      nodeIndex: i,
      pointIndex: hit.index,
      point: hit.point,
      depth: node.depth,
      score,
    };
  }

  if (best === null) return null;
  return {
    nodeIndex: best.nodeIndex,
    pointIndex: best.pointIndex,
    point: best.point,
    streamingRefining: best.depth < maxResidentDepth,
  };
}
