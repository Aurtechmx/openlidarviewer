/**
 * StreamingNode.ts
 *
 * The runtime octree node for COPC streaming: an immutable parsed
 * {@link StreamingNodeRecord} plus the mutable streaming state (lifecycle,
 * score, last-used tick). The node carries no three.js handle — the GPU mesh
 * for a resident node is owned by `StreamingRenderer`, which keeps this module
 * pure and unit-testable in Node.
 *
 * Pure — no DOM, no three.js.
 */

import type { StreamingNodeRecord, VoxelKey } from '../../io/copc/copcTypes';

/**
 * A node's lifecycle state.
 *
 * `unloaded` → `queued` → `loading` → `resident`, and back to `unloaded` on
 * eviction. `error` is terminal for a node whose chunk failed to decode.
 * Decode and GPU upload are atomic in `StreamingRenderer`, so there is no
 * separate CPU-resident state between `loading` and `resident`.
 */
export type NodeState = 'unloaded' | 'queued' | 'loading' | 'resident' | 'error';

/** A runtime octree node — its parsed record plus mutable streaming state. */
export interface StreamingNode {
  /** The immutable parsed record (id, key, bounds, chunk location, …). */
  readonly record: StreamingNodeRecord;
  /** Current lifecycle state. */
  state: NodeState;
  /** Failure detail when `state === 'error'`. */
  error?: string;
  /** Ids of child nodes, resolved as the hierarchy loads. */
  childIds: string[];
  /** Points decoded and uploaded to the GPU — non-zero only while resident. */
  residentPointCount: number;
  /** Priority score from the most recent scheduler tick. */
  score: number;
  /** Scheduler tick index when this node was last in the working set (LRU). */
  lastUsedTick: number;
}

/** Create a fresh, unloaded runtime node from a parsed record. */
export function createStreamingNode(record: StreamingNodeRecord): StreamingNode {
  return {
    record,
    state: 'unloaded',
    childIds: [],
    residentPointCount: 0,
    score: 0,
    lastUsedTick: 0,
  };
}

/** A node's id. */
export function nodeId(node: StreamingNode): string {
  return node.record.id;
}

/** A node's octree key. */
export function nodeKey(node: StreamingNode): VoxelKey {
  return node.record.key;
}
