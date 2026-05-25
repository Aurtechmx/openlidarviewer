/**
 * StreamingScheduler.ts
 *
 * The view-dependent COPC streaming scheduler. Each `update` it culls the
 * octree against the camera frustum, scores the visible nodes coarse-first,
 * selects the set that fits the point budget, enqueues the missing nodes,
 * evicts the surplus, and dispatches a bounded number of decodes.
 *
 * Deliberately three.js-free: it takes a plain view-projection matrix and
 * camera position (the Viewer extracts those), and decodes through the
 * `ChunkDecoder` interface — so the whole scheduler is unit-tested in Node
 * with a synthetic COPC and a fake decoder.
 */

import type { Box6 } from '../../io/copc/copcTypes';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../io/copc/copcChunkDecode';
import type { StreamingPointCloud } from './StreamingPointCloud';
import type { StreamingNode } from './StreamingNode';
import {
  frustumPlanesFromViewProjection,
  boxInFrustum,
  nodeScore,
  depthCapForVelocity,
} from './streamingScore';
import { selectWithinBudget } from './streamingBudget';
import type { StreamingBudgets, ScoredCandidate } from './streamingBudget';
import { CompressedChunkCache } from './StreamingCache';

/** Renderer-facing callbacks the scheduler drives. */
export interface SchedulerCallbacks {
  /** A node decoded and is ready to upload to the GPU. */
  onNodeReady(node: StreamingNode, decoded: DecodedChunk): void;
  /** A node left the working set — drop its GPU mesh. */
  onNodeEvicted(node: StreamingNode): void;
  /** Node counts changed — a hint to refresh streaming UI. */
  onChange?(): void;
}

/** The camera view for one scheduling pass, in local render space. */
export interface SchedulerView {
  /** Column-major view-projection matrix (16 numbers). */
  viewProjection: ArrayLike<number>;
  /** Camera position. */
  cameraPosition: [number, number, number];
}

/** Live scheduler counters for diagnostics. */
export interface SchedulerStats {
  /** Nodes inside the frustum at the last tick. */
  visible: number;
  queued: number;
  loading: number;
  /** Wall time of the most recent `update`, in milliseconds. */
  lastTickMs: number;
}

/** The deepest octree level the scheduler will descend to when still. */
const BASE_DEPTH_CAP = 18;

/** The view-dependent COPC streaming scheduler. */
export class StreamingScheduler {
  private readonly _cloud: StreamingPointCloud;
  private readonly _decoder: ChunkDecoder;
  private readonly _callbacks: SchedulerCallbacks;
  private readonly _localBounds = new Map<string, Box6>();
  private readonly _queue: StreamingNode[] = [];
  private readonly _inFlight = new Map<string, AbortController>();
  private readonly _cache: CompressedChunkCache;

  private _pointBudget: number;
  private _maxConcurrent: number;
  private _lastCameraPos: [number, number, number] | null = null;
  private _tick = 0;
  private _paused = false;
  private _lastTickMs = 0;
  private _lastVisible = 0;

  constructor(
    cloud: StreamingPointCloud,
    decoder: ChunkDecoder,
    callbacks: SchedulerCallbacks,
    budgets: StreamingBudgets,
  ) {
    this._cloud = cloud;
    this._decoder = decoder;
    this._callbacks = callbacks;
    this._pointBudget = budgets.pointBudget;
    this._maxConcurrent = budgets.maxConcurrentDecodes;
    this._cache = new CompressedChunkCache(budgets.chunkCacheBytes);
    // Precompute each node's bounds in local render space (world − origin).
    const [rx, ry, rz] = cloud.renderOrigin;
    for (const node of cloud.octree.nodes()) {
      const b = node.record.bounds;
      this._localBounds.set(node.record.id, [
        b[0] - rx,
        b[1] - ry,
        b[2] - rz,
        b[3] - rx,
        b[4] - ry,
        b[5] - rz,
      ]);
    }
  }

  /** Apply new point and concurrency budgets (a quality-preset change). */
  setBudgets(
    budgets: Pick<StreamingBudgets, 'pointBudget' | 'maxConcurrentDecodes'>,
  ): void {
    this._pointBudget = budgets.pointBudget;
    this._maxConcurrent = budgets.maxConcurrentDecodes;
  }

  /** Drop every cached compressed chunk. */
  clearCache(): void {
    this._cache.clear();
  }

  /** Compressed-chunk cache usage — for the streaming panel and diagnostics. */
  cacheStats(): { byteSize: number; count: number; maxBytes: number } {
    return {
      byteSize: this._cache.byteSize,
      count: this._cache.count,
      maxBytes: this._cache.maxBytes,
    };
  }

  /** Pause streaming — no new work is scheduled or dispatched. */
  pause(): void {
    this._paused = true;
  }

  /** Resume streaming. */
  resume(): void {
    this._paused = false;
  }

  /** Whether streaming is currently paused. */
  get paused(): boolean {
    return this._paused;
  }

  /** Live counters for the diagnostics overlay. */
  stats(): SchedulerStats {
    let queued = 0;
    for (const node of this._cloud.octree.nodes()) {
      if (node.state === 'queued') queued++;
    }
    return {
      visible: this._lastVisible,
      queued,
      loading: this._inFlight.size,
      lastTickMs: this._lastTickMs,
    };
  }

  /** A node's local-space bounds. */
  localBoundsOf(id: string): Box6 | undefined {
    return this._localBounds.get(id);
  }

  /**
   * Run one scheduling pass: cull, score, select within budget, evict the
   * surplus, enqueue the missing, and dispatch decodes.
   */
  update(view: SchedulerView): void {
    if (this._paused) return;
    const startedAt = nowMs();
    this._tick++;

    const velocity = this._lastCameraPos
      ? distance(view.cameraPosition, this._lastCameraPos)
      : 0;
    this._lastCameraPos = [...view.cameraPosition];
    const depthCap = depthCapForVelocity(BASE_DEPTH_CAP, velocity);
    const planes = frustumPlanesFromViewProjection(view.viewProjection);
    const store = this._cloud.octree.store;

    // A node queued last tick is reconsidered fresh — reset it to unloaded.
    for (const node of this._cloud.octree.nodes()) {
      if (node.state === 'queued') store.setState(node, 'unloaded');
    }

    // Score every visible node.
    const scored: { node: StreamingNode; candidate: ScoredCandidate }[] = [];
    for (const node of this._cloud.octree.nodes()) {
      const box = this._localBounds.get(node.record.id);
      let score = 0;
      if (box && boxInFrustum(box, planes)) {
        score = nodeScore({
          bounds: box,
          depth: node.record.key.depth,
          cameraPos: view.cameraPosition,
          depthCap,
        });
      }
      node.score = score;
      if (score > 0) {
        node.lastUsedTick = this._tick;
        scored.push({
          node,
          candidate: { id: node.record.id, pointCount: node.record.pointCount, score },
        });
      }
    }
    this._lastVisible = scored.length;
    scored.sort((a, b) => b.candidate.score - a.candidate.score);
    const wanted = selectWithinBudget(
      scored.map((s) => s.candidate),
      this._pointBudget,
    );

    // Evict resident nodes that are no longer wanted.
    for (const node of store.resident()) {
      if (!wanted.has(node.record.id)) {
        this._callbacks.onNodeEvicted(node);
        store.setState(node, 'unloaded');
      }
    }

    // Cancel in-flight decodes for nodes that left the working set.
    for (const [id, controller] of this._inFlight) {
      if (!wanted.has(id)) controller.abort();
    }

    // Enqueue wanted nodes that are not already resident or loading.
    this._queue.length = 0;
    for (const { node } of scored) {
      if (
        wanted.has(node.record.id) &&
        node.state !== 'resident' &&
        node.state !== 'loading'
      ) {
        store.setState(node, 'queued');
        this._queue.push(node);
      }
    }

    this._dispatch();
    this._lastTickMs = nowMs() - startedAt;
    this._callbacks.onChange?.();
  }

  /** Cancel every queued and in-flight decode — used on close. */
  stop(): void {
    for (const controller of this._inFlight.values()) controller.abort();
    this._inFlight.clear();
    this._queue.length = 0;
  }

  /** Dispatch decodes until the concurrency limit is reached. */
  private _dispatch(): void {
    while (this._inFlight.size < this._maxConcurrent && this._queue.length > 0) {
      const node = this._queue.shift();
      if (!node || node.state !== 'queued') continue;
      this._startDecode(node);
    }
  }

  /** Read and decode one node's chunk, then hand the result to the renderer. */
  private _startDecode(node: StreamingNode): void {
    const id = node.record.id;
    const controller = new AbortController();
    this._inFlight.set(id, controller);
    const store = this._cloud.octree.store;
    store.setState(node, 'loading');

    const meta = this._decodeMeta(node);
    this._readChunk(node, controller.signal)
      .then((chunk) => this._decoder.decode(chunk, meta, controller.signal))
      .then((decoded) => {
        this._inFlight.delete(id);
        if (controller.signal.aborted) {
          store.setState(node, 'unloaded');
        } else {
          store.setState(node, 'resident', decoded.pointCount);
          this._callbacks.onNodeReady(node, decoded);
        }
        this._dispatch();
        this._callbacks.onChange?.();
      })
      .catch((err: unknown) => {
        this._inFlight.delete(id);
        if (controller.signal.aborted) {
          store.setState(node, 'unloaded');
        } else {
          store.setError(node, err instanceof Error ? err.message : String(err));
        }
        this._dispatch();
        this._callbacks.onChange?.();
      });
  }

  /**
   * Read a node's compressed chunk — from the cache when present, otherwise
   * from the file (caching the result). The returned buffer is always a fresh
   * copy, safe to transfer to the decode worker without neutering the cache.
   */
  private async _readChunk(
    node: StreamingNode,
    signal: AbortSignal,
  ): Promise<ArrayBuffer> {
    const id = node.record.id;
    const cached = this._cache.get(id);
    if (cached) return cached.slice(0);
    const fresh = await this._cloud.source.readNodeChunk(node.record, signal);
    this._cache.put(id, fresh);
    return fresh.slice(0);
  }

  /** Build the per-node decode metadata. */
  private _decodeMeta(node: StreamingNode): ChunkDecodeMetadata {
    const header = this._cloud.metadata.header;
    return {
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointRecordLength: header.pointRecordLength,
      pointCount: node.record.pointCount,
      scale: header.scale,
      offset: header.offset,
      renderOrigin: this._cloud.renderOrigin,
    };
  }
}

/** Euclidean distance between two points. */
function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** A monotonic millisecond clock, available on both the main thread and Node. */
function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
