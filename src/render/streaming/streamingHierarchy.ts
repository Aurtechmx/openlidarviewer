/**
 * streamingHierarchy.ts
 *
 * Ancestry over explicit parent identity, for every streaming format.
 *
 * The scheduler used to reconstruct a node's ancestors by right-shifting its
 * `VoxelKey` axes, which is exact for a regular octree and meaningless for any
 * hierarchy that is not one. COPC, EPT and the OLV tile store already record
 * `parentId` on every node record and link `childIds` on the runtime node, so
 * the relationship the scheduler needs is present without deriving it from
 * coordinates. This module is that walk.
 *
 * The walk is allocation-free per node: no set, no array, no closure state
 * beyond the two locals below. The scheduler runs it over every candidate and
 * every resident node on a tick, so anything it allocates is allocated
 * thousands of times a second.
 *
 * A malformed hierarchy can name a parent that is its own descendant. The step
 * ceiling below terminates such a walk. It is a backstop against hostile or
 * corrupt input, not a limit on how deep a real hierarchy may be: COPC and EPT
 * octrees bottom out around depth 20, and the ceiling sits an order of
 * magnitude above that.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

/** A node's parent id, or `undefined` at a root or for an unknown node. */
export type ParentLookup = (id: string) => string | undefined;

/**
 * Steps a single ancestor walk may take before it stops.
 *
 * Reached only by a cycle or by a hierarchy deeper than any format OLV reads.
 * A walk that hits it stops early rather than throwing: the sets these walks
 * build are protection and refinement hints, and the safe answer for a
 * hierarchy this deep is to protect fewer nodes, never to fail a frame.
 */
export const MAX_ANCESTOR_STEPS = 256;

/**
 * Visit every ancestor id of `id`, nearest parent first, up to the root.
 *
 * The node itself is not visited. Stops at the first id with no recorded
 * parent, which is how a partially loaded hierarchy terminates: an EPT page
 * that has not arrived yet leaves its subtree unreachable, and the walk ends
 * there rather than inventing the ids above it.
 */
export function forEachAncestorId(
  id: string,
  parentOf: ParentLookup,
  visit: (ancestorId: string) => void,
): void {
  let current = parentOf(id);
  for (let steps = 0; current !== undefined && steps < MAX_ANCESTOR_STEPS; steps++) {
    visit(current);
    current = parentOf(current);
  }
}

/**
 * A {@link ParentLookup} backed by a streaming node store.
 *
 * Kept here rather than inlined at each call site so the scheduler holds one
 * closure per tick instead of one per walk.
 */
export function parentLookupFromStore(store: {
  get(id: string): { readonly record: { readonly parentId?: string } } | undefined;
}): ParentLookup {
  return (id) => store.get(id)?.record.parentId;
}
