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
   * Live count of nodes in the `queued` state, maintained at every
   * transition through {@link setState}. Lets the scheduler report the
   * queued count in O(1) instead of walking every node — the diagnostics
   * `stats()` and the per-frame `_shouldRenderFrame` idle-render check both
   * read it on the hot path. All state mutations route through `setState`,
   * so this counter cannot drift from a ground-truth walk.
   */
  private _queuedCount = 0;

  /**
   * Live sets of the nodes currently in the `resident` and `queued` states,
   * maintained at every {@link setState} transition. The scheduler walks these
   * every tick (~10 Hz) for a 28 k-node cloud; materialising them from a full
   * `all().filter(...)` walk allocated two throwaway 28 k-element arrays per
   * tick (one for `all()`, one for the filtered result) and re-scanned every
   * node even when only a few hundred were resident — a per-tick GC + walk cost
   * that scaled with the WHOLE hierarchy, not the working set. These maintained
   * sets make the hot-path walks O(resident) / O(queued) with zero allocation.
   * Iteration order follows Map/Set insertion order, matching the old
   * `all().filter` ordering closely enough for the scheduler (which sorts its
   * own candidates and is order-independent for eviction).
   */
  private readonly _resident = new Set<StreamingNode>();
  private readonly _queued = new Set<StreamingNode>();

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

  /** Every known node (allocates — prefer {@link iterate} on hot paths). */
  all(): StreamingNode[] {
    return [...this._nodes.values()];
  }

  /**
   * Zero-allocation iterable over every known node — the hot-path alternative
   * to {@link all}, which materialises a 28 k-element array. The scheduler's
   * per-tick rescore uses this so a stable 28 k-node cloud no longer allocates
   * a throwaway array ~10×/s.
   */
  iterate(): IterableIterator<StreamingNode> {
    return this._nodes.values();
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
   * Count of nodes currently in the `queued` state — maintained O(1) at
   * every {@link setState} transition. Equals a full walk that counts
   * `queued` nodes, but without the walk.
   */
  get queuedCount(): number {
    return this._queuedCount;
  }

  /**
   * Transition a node to a new state, keeping the resident-point total exact.
   * `residentPointCount` is the decoded point count and is recorded only for
   * the `resident` state.
   */
  setState(node: StreamingNode, state: NodeState, residentPointCount = 0): void {
    if (node.state === 'resident') {
      this._residentPoints -= node.residentPointCount;
      this._resident.delete(node);
    }
    // Maintain the O(1) queued counter + the resident/queued working sets at
    // the transition: every state change (enqueue, dequeue-to-load, decode,
    // cancel, evict-reset, stop) routes through here, so the counter and the
    // sets track a ground-truth walk without one. The sets let the scheduler's
    // per-tick eviction + queued-reset passes run O(resident)/O(queued) with
    // zero allocation instead of `all().filter(...)` over the whole hierarchy.
    if (node.state === 'queued') { this._queuedCount--; this._queued.delete(node); }
    node.state = state;
    node.residentPointCount = state === 'resident' ? residentPointCount : 0;
    if (state === 'resident') {
      this._residentPoints += residentPointCount;
      this._resident.add(node);
    }
    if (state === 'queued') { this._queuedCount++; this._queued.add(node); }
    if (state !== 'error') node.error = undefined;
  }

  /** Mark a node failed, with a reason. */
  setError(node: StreamingNode, reason: string): void {
    this.setState(node, 'error');
    node.error = reason;
  }

  /**
   * Every resident node — the candidate set for eviction. Served from the
   * maintained resident set, so this is O(resident) with one small array
   * allocation rather than `all().filter` over the whole 28 k-node hierarchy.
   */
  resident(): StreamingNode[] {
    return [...this._resident];
  }

  /**
   * Zero-allocation iterable over the resident nodes — the scheduler's
   * per-tick eviction pass uses this to avoid materialising any array.
   */
  residentNodes(): IterableIterator<StreamingNode> {
    return this._resident.values();
  }

  /**
   * Zero-allocation iterable over the queued nodes — the scheduler's per-tick
   * "reconsider queued" reset uses this so it touches only the (few) queued
   * nodes, not all 28 k.
   */
  queuedNodes(): IterableIterator<StreamingNode> {
    return this._queued.values();
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
