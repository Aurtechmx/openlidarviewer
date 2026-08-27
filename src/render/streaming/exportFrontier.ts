/**
 * exportFrontier.ts
 *
 * Deterministic frontier for the streaming resident-snapshot export (v0.5.7
 * Gate 5). Where a node's children REPLACE it, an LOD cross-fade can leave the
 * outgoing parent and its incoming children both resident, and a naive snapshot
 * then concatenates overlapping LOD samples of the same region — the coarse
 * parent points and the finer child points together. This module computes the
 * frontier to keep before the snapshot is built: along a replacing path keep
 * the deepest resident node and drop any ancestor that has a resident
 * descendant, and exclude nodes that are fading out (they are on their way off
 * screen) whatever their mode.
 *
 * Over a replacing hierarchy the result is an antichain of the resident set —
 * no kept node is an ancestor of another kept node — so each region is
 * represented once, at its finest resident level, with no double sampling. Over
 * an additive one, which is what every source shipped today is, the frontier is
 * the whole non-fading resident set: nothing there is a duplicate to remove.
 *
 * Ancestry arrives as explicit parent identity rather than octree-key
 * arithmetic, so a hierarchy that is not a regular octree answers the same
 * question. A resident node's parent is frequently not itself resident, so the
 * caller supplies a lookup over the whole hierarchy, not just the nodes passed
 * in.
 *
 * Pure: identity math only (no DOM, no three.js, no GPU), so the frontier is
 * verifiable without a device. The renderer supplies `{ id, fadingOut }` for
 * each resident node; the caller keeps only the returned ids.
 *
 * Trade-off, stated explicitly: a REPLACING parent is dropped when it has ANY
 * resident descendant, even if only some of its children are covered by
 * resident nodes. In the streaming model children of a node load as a group and
 * a fully-refined parent is evicted (and thus fading out), so partial-coverage
 * parents are transient; dropping them removes duplicate coarse points rather
 * than creating gaps in the steady state. The alternative — keeping partially
 * covered parents — would reintroduce the very overlap this frontier exists to
 * remove.
 *
 * That trade-off is only sound where a child REPLACES its parent. It is not how
 * any source this viewer opens is built: COPC, EPT and the OLV tile store each
 * partition their points across the octree, so a parent holds points its
 * children do not repeat, and 3D Tiles reaches the scheduler only under ADD
 * because `tilesetNodes` refuses a REPLACE tile that refines into content.
 * Under additive refinement a parent and its children are both part of the
 * represented surface, so an additive node is never dropped for having a
 * descendant — dropping it deletes points the export carries nowhere else.
 *
 * The mode travels with each node rather than with the source, because one
 * hierarchy may mix the two, and an unstated mode is read as additive: see
 * {@link FrontierNode.refine}.
 */

import type { NodeRefinement } from '../../io/copc/copcTypes';
import type { ParentLookup } from './streamingHierarchy';
import { forEachAncestorId } from './streamingHierarchy';

/**
 * How a node's children relate to it.
 *
 * `'replace'` — the children are a finer representation of the same region, so
 * the parent is redundant once they are resident.
 * `'add'` — the children are extra detail alongside the parent, so both belong
 * in the snapshot.
 *
 * The same type the node records carry, so a caller passes `record.refine`
 * straight through.
 */
export type FrontierRefine = NodeRefinement;

/** A resident node as the frontier needs it. */
export interface FrontierNode {
  /** The node id (the resident map key). */
  readonly id: string;
  /** True while the node is animating out during a cross-fade. */
  readonly fadingOut?: boolean;
  /**
   * How this node's children refine it, from `StreamingNodeRecord.refine`.
   *
   * Unstated means `'add'`, the direction that KEEPS the node. That is the safe
   * default in the only sense that matters here: reading an additive node as
   * replacing drops it, and its points are then in no exported node at all,
   * while reading a replacing node as additive at worst writes one coarse
   * sample of a region twice. It also happens to be the true mode for every
   * source shipped today. The default used to be `'replace'`, which silently
   * cut the coarse levels out of every streamed export.
   */
  readonly refine?: FrontierRefine;
}

/**
 * Compute the set of node ids to keep for the export snapshot.
 *
 * A node is kept when it is not fading out AND it is not a replacing ancestor
 * of another non-fading resident node. A node that does not state a replacing
 * mode is kept whenever it is not fading out.
 */
export function computeExportFrontier(
  nodes: readonly FrontierNode[],
  parentOf: ParentLookup,
): Set<string> {
  // Candidates: everything not on its way out. A fading-out node is leaving the
  // scene, so it should not contribute to a stable export.
  const candidates = nodes.filter((n) => n.fadingOut !== true);

  // Mark every ancestor id of every candidate. Any candidate whose id lands in
  // this set has a resident descendant and is therefore a redundant coarser
  // ancestor to drop. Climbing to the root is O(depth) per node.
  const ancestorsOfResident = new Set<string>();
  for (const node of candidates) {
    forEachAncestorId(node.id, parentOf, (ancestorId) => ancestorsOfResident.add(ancestorId));
  }

  const keep = new Set<string>();
  for (const node of candidates) {
    // Only a node that says its children REPLACE it can be dropped for having
    // one. Anything else — additive, or a node that states nothing — keeps its
    // own points.
    if (node.refine !== 'replace') keep.add(node.id);
    else if (!ancestorsOfResident.has(node.id)) keep.add(node.id);
  }
  return keep;
}
