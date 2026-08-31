/**
 * replaceFrontier.ts
 *
 * The live-render frontier for a hierarchy whose children REPLACE their parent
 * (3D Tiles `refine: 'REPLACE'`). The streaming renderer draws every resident
 * node, which is correct for an ADDITIVE hierarchy — COPC, EPT and the OLV tile
 * store each partition their points across levels, so a parent holds points its
 * children never repeat and parent + children resident is a correct union. A
 * replacing hierarchy breaks that: the children re-represent the parent's
 * region, so drawing both is genuine double geometry over one surface. This
 * module decides which resident nodes to HIDE so the scene shows each region
 * once, at the finest fully-resident level, and — the load-bearing constraint —
 * never leaves a hole while a level is still arriving.
 *
 * THE NO-HOLE RULE. A replacing parent is refined away (hidden, its children
 * shown) ONLY when every one of its children is resident. Until then the parent
 * is kept and its whole subtree is withheld, so the transition is an atomic
 * parent → children swap with no instant where part of the surface is missing
 * and no instant where a coarse parent overlaps a fine child. This differs from
 * the export frontier ({@link computeExportFrontier}), which drops a replacing
 * parent as soon as it has ANY resident descendant: an export is a steady-state
 * snapshot where partial-coverage parents are transient and a duplicate coarse
 * sample is the worse outcome, whereas a live frame must not flash a gap.
 *
 * The cost of the rule is conservatism, not incorrectness: a parent straddling
 * the view frustum, whose off-screen children are never selected, keeps its
 * coarse representation rather than refining. That shows coarser detail at a
 * view edge, never a hole and never doubled geometry. A parent fully in view
 * refines as soon as its children fit the budget and land.
 *
 * Pure: identity and residency only (no DOM, no three.js, no GPU), so the
 * frontier is verifiable without a device. An additive hierarchy — every source
 * but a REPLACE tileset — has no replacing node, so the hidden set is always
 * empty and the renderer draws exactly what it draws today.
 */

import type { NodeRefinement } from '../../io/copc/copcTypes';

/** A node as the live frontier needs it. */
export interface ReplaceFrontierNode {
  /** The node id (the resident-map key). */
  readonly id: string;
  /**
   * How this node's children refine it, from `StreamingNodeRecord.refine`.
   * Unstated (or `'add'`) means additive: the node is never hidden for having a
   * descendant, matching every source but a REPLACE tileset.
   */
  readonly refine?: NodeRefinement;
  /** Whether the node is currently resident (drawable) on the GPU. */
  readonly resident: boolean;
  /** Ids of this node's content children, as the store links them. */
  readonly childIds: readonly string[];
  /** Nearest ancestor that produced a node, or undefined at a root. */
  readonly parentId?: string;
}

/**
 * The ids of resident nodes that must NOT be drawn this frame.
 *
 * A resident node is hidden when either:
 *  - it is a REPLACE node all of whose children are resident (its children now
 *    cover it — it is refined away); or
 *  - some ancestor is a "blocker": a resident REPLACE node NOT all of whose
 *    children are resident, which is still representing its whole region because
 *    its replacement is incomplete, so everything beneath it is withheld.
 *
 * An additive hierarchy has no REPLACE node, so nothing is ever hidden and the
 * returned set is empty.
 */
export function computeReplaceHidden(
  nodes: readonly ReplaceFrontierNode[],
): Set<string> {
  const byId = new Map<string, ReplaceFrontierNode>();
  for (const node of nodes) byId.set(node.id, node);

  const isResident = (id: string): boolean => byId.get(id)?.resident === true;

  // A REPLACE node is "covered" when it has children and every one is resident,
  // so its children fully re-represent its region.
  const covered = (node: ReplaceFrontierNode): boolean =>
    node.childIds.length > 0 && node.childIds.every(isResident);

  // A "blocker" holds its whole region because its replacement is incomplete:
  // resident, replacing, and not yet covered. Everything under it is withheld.
  const blockers = new Set<string>();
  for (const node of nodes) {
    if (node.resident && node.refine === 'replace' && !covered(node)) {
      blockers.add(node.id);
    }
  }

  const hidden = new Set<string>();
  for (const node of nodes) {
    if (!node.resident) continue;
    // Refined away: its children now cover it.
    if (node.refine === 'replace' && covered(node)) {
      hidden.add(node.id);
      continue;
    }
    // Withheld: an ancestor is still representing its whole region. Walk up the
    // parent chain; the highest blocker draws and suppresses everything below.
    for (let id = node.parentId; id !== undefined; ) {
      if (blockers.has(id)) {
        hidden.add(node.id);
        break;
      }
      id = byId.get(id)?.parentId;
    }
  }
  return hidden;
}
