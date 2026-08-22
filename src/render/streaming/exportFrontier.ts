/**
 * exportFrontier.ts
 *
 * Deterministic leaf-node frontier for the streaming resident-snapshot export
 * (v0.5.7 Gate 5). During an LOD cross-fade the outgoing parent node and its
 * incoming children can both be resident, so a naive snapshot concatenates
 * overlapping LOD samples of the same region — the coarse parent points and the
 * finer child points together. This module computes the frontier to keep before
 * the snapshot is built: for each hierarchy path keep the deepest resident node
 * and drop any ancestor that has a resident descendant, and exclude nodes that
 * are fading out (they are on their way off screen).
 *
 * The result is an antichain of the resident set — no kept node is an ancestor
 * of another kept node — so each region is represented once, at its finest
 * resident level, with no double sampling.
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
 * Trade-off, stated explicitly: a REPLACE parent is dropped when it has ANY
 * resident descendant, even if only some of its children are covered by
 * resident nodes. In the streaming model children of a node load as a group and
 * a fully-refined parent is evicted (and thus fading out), so partial-coverage
 * parents are transient; dropping them removes duplicate coarse points rather
 * than creating gaps in the steady state. The alternative — keeping partially
 * covered parents — would reintroduce the very overlap this frontier exists to
 * remove.
 *
 * That trade-off is only sound where a child REPLACES its parent, which is what
 * COPC, EPT and the OLV tile store all do. Under additive refinement a parent
 * and its children are both part of the represented surface, so an additive
 * node is never dropped for having a descendant. The mode travels with each
 * node rather than with the source, because one hierarchy may mix the two.
 */

import type { ParentLookup } from './streamingHierarchy';
import { forEachAncestorId } from './streamingHierarchy';

/**
 * How a node's children relate to it.
 *
 * `'replace'` — the children are a finer representation of the same region, so
 * the parent is redundant once they are resident.
 * `'add'` — the children are extra detail alongside the parent, so both belong
 * in the snapshot.
 */
export type FrontierRefine = 'replace' | 'add';

/** A resident node as the frontier needs it. */
export interface FrontierNode {
  /** The node id (the resident map key). */
  readonly id: string;
  /** True while the node is animating out during a cross-fade. */
  readonly fadingOut?: boolean;
  /** Defaults to `'replace'`, which is what every format shipped today uses. */
  readonly refine?: FrontierRefine;
}

/**
 * Compute the set of node ids to keep for the export snapshot.
 *
 * A node is kept when it is not fading out AND it is not a replacing ancestor
 * of another non-fading resident node.
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
    if (node.refine === 'add') keep.add(node.id);
    else if (!ancestorsOfResident.has(node.id)) keep.add(node.id);
  }
  return keep;
}
