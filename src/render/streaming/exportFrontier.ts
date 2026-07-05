/**
 * exportFrontier.ts
 *
 * Deterministic leaf-node frontier for the streaming resident-snapshot export
 * (v0.5.7 Gate 5). During an LOD cross-fade the outgoing parent node and its
 * incoming children can both be resident, so a naive snapshot concatenates
 * overlapping LOD samples of the same region — the coarse parent points and the
 * finer child points together. This module computes the frontier to keep before
 * the snapshot is built: for each octree path keep the deepest resident node and
 * drop any ancestor that has a resident descendant, and exclude nodes that are
 * fading out (they are on their way off screen).
 *
 * The result is an antichain of the resident set — no kept node is an ancestor
 * of another kept node — so each region is represented once, at its finest
 * resident level, with no double sampling.
 *
 * Pure: octree-key math only (no DOM, no three.js, no GPU), so the frontier is
 * verifiable without a device. The renderer supplies `{ id, key, fadingOut }`
 * for each resident node; the caller keeps only the returned ids.
 *
 * Trade-off, stated explicitly: a parent is dropped when it has ANY resident
 * descendant, even if only some of its eight octants are covered by resident
 * children. In the streaming model children of a node load as a group and a
 * fully-refined parent is evicted (and thus fading out), so partial-coverage
 * parents are transient; dropping them removes duplicate coarse points rather
 * than creating gaps in the steady state. The alternative — keeping partially
 * covered parents — would reintroduce the very overlap this frontier exists to
 * remove.
 */

import type { VoxelKey } from '../../io/copc/copcTypes';
import { keyId, parentKey } from '../../io/copc/voxelKey';

/** A resident node as the frontier needs it. */
export interface FrontierNode {
  /** The `"depth-x-y-z"` id (the resident map key). */
  readonly id: string;
  /** The octree key, for ancestor/descendant reasoning. */
  readonly key: VoxelKey;
  /** True while the node is animating out during a cross-fade. */
  readonly fadingOut?: boolean;
}

/**
 * Compute the set of node ids to keep for the export snapshot.
 *
 * A node is kept when it is not fading out AND no other non-fading resident node
 * is a strict descendant of it. Fading-out nodes are excluded entirely.
 */
export function computeExportFrontier(nodes: readonly FrontierNode[]): Set<string> {
  // Candidates: everything not on its way out. A fading-out node is leaving the
  // scene, so it should not contribute to a stable export.
  const candidates = nodes.filter((n) => n.fadingOut !== true);

  // Mark every ancestor id of every candidate. Any candidate whose id lands in
  // this set has a resident descendant and is therefore a redundant coarser
  // ancestor to drop. Climbing to the root is O(depth) per node.
  const ancestorsOfResident = new Set<string>();
  for (const node of candidates) {
    let parent = parentKey(node.key);
    while (parent) {
      ancestorsOfResident.add(keyId(parent));
      parent = parentKey(parent);
    }
  }

  const keep = new Set<string>();
  for (const node of candidates) {
    if (!ancestorsOfResident.has(node.id)) keep.add(node.id);
  }
  return keep;
}
