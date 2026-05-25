/**
 * StreamingNodeStore.ts
 *
 * The single source of truth for every known COPC octree node and the live
 * counts the scheduler, cache, and diagnostics read. State transitions go
 * through `setState` so the resident-point total stays exact.
 *
 * Pure — no DOM, no three.js.
 */

import type { StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { StreamingNode, NodeState } from './StreamingNode';
import { createStreamingNode } from './StreamingNode';

/** Live node counts by lifecycle state. */
export interface NodeCounts {
  /** All nodes the hierarchy has revealed. */
  known: number;
  queued: number;
  loading: number;
  resident: number;
  error: number;
}

/** Owns every known node and keeps resident-point accounting exact. */
export class StreamingNodeStore {
  private readonly _nodes = new Map<string, StreamingNode>();
  private _residentPoints = 0;

  /**
   * Register a node record discovered in the hierarchy. Idempotent — a record
   * already present (by id) returns the existing runtime node unchanged.
   */
  add(record: StreamingNodeRecord): StreamingNode {
    const existing = this._nodes.get(record.id);
    if (existing) return existing;
    const node = createStreamingNode(record);
    this._nodes.set(record.id, node);
    return node;
  }

  /** Look up a node by id. */
  get(id: string): StreamingNode | undefined {
    return this._nodes.get(id);
  }

  /** Whether a node id is known. */
  has(id: string): boolean {
    return this._nodes.has(id);
  }

  /** Every known node. */
  all(): StreamingNode[] {
    return [...this._nodes.values()];
  }

  /** Count of known nodes. */
  get size(): number {
    return this._nodes.size;
  }

  /** Total points currently uploaded to the GPU across resident nodes. */
  get residentPointCount(): number {
    return this._residentPoints;
  }

  /**
   * Transition a node to a new state, keeping the resident-point total exact.
   * `residentPointCount` is the decoded point count and is recorded only for
   * the `resident` state.
   */
  setState(node: StreamingNode, state: NodeState, residentPointCount = 0): void {
    if (node.state === 'resident') {
      this._residentPoints -= node.residentPointCount;
    }
    node.state = state;
    node.residentPointCount = state === 'resident' ? residentPointCount : 0;
    if (state === 'resident') {
      this._residentPoints += residentPointCount;
    }
    if (state !== 'error') node.error = undefined;
  }

  /** Mark a node failed, with a reason. */
  setError(node: StreamingNode, reason: string): void {
    this.setState(node, 'error');
    node.error = reason;
  }

  /** Every resident node — the candidate set for eviction. */
  resident(): StreamingNode[] {
    return this.all().filter((n) => n.state === 'resident');
  }

  /** Live counts by state — cheap enough for the ~4 Hz diagnostics poll. */
  counts(): NodeCounts {
    let queued = 0;
    let loading = 0;
    let resident = 0;
    let error = 0;
    for (const node of this._nodes.values()) {
      if (node.state === 'queued') queued++;
      else if (node.state === 'loading') loading++;
      else if (node.state === 'resident') resident++;
      else if (node.state === 'error') error++;
    }
    return { known: this._nodes.size, queued, loading, resident, error };
  }
}
