/**
 * copcWorkerClient.ts
 *
 * The main-thread client for the COPC decode workers. It implements the
 * `ChunkDecoder` interface, so the streaming scheduler depends only on that
 * interface — and tests can swap in a fake decoder with no worker at all.
 *
 * The client is a thin adapter over {@link DecodeWorkerPool}: it owns the COPC
 * wire format (`{ type: 'decode', requestId, chunk, meta }`, the chunk buffer
 * transferred zero-copy) and the COPC-specific error wording, and delegates
 * request-id multiplexing, queueing, dispatch, cancellation, worker-failure
 * isolation and disposal to the pool. Every one of those rules is identical in
 * the EPT client, which is why they live in one place.
 *
 * WHY A POOL. A single worker serialises every decode behind one laz-perf
 * instance, so a dense cloud's chunks decode one at a time however many cores
 * the machine has. Several workers decode in parallel; the cost is one WASM
 * heap each, which is why the size comes from a device-aware policy
 * ({@link resolveDecodePoolSize}) rather than a constant, and why workers past
 * the first are created only when there is actually a second chunk to decode.
 *
 * POOLING IS OFF BY DEFAULT. Absent a flag this client builds a ONE-worker
 * pool, which is behaviourally the pre-pool client. `?decodePool=on` opts in at
 * the policy's size and `?decodeWorkers=N` pins the count; the `poolSize`
 * option below is the same switch for tests. It stays opt-in until a browser
 * run on a real dataset measures throughput and the memory cost of N WASM
 * heaps under a fast camera sweep.
 *
 * The file-level RGB bit-depth decision is NOT affected by pooling: it is taken
 * on the main thread by the streaming source and passed down in
 * `meta.rgbEightBit`, and the worker only ever consumes it. No worker derives
 * its own, so a cloud cannot end up rendered at two colour depths.
 *
 * Browser-bound by default (the default factory constructs a `Worker`), but the
 * factory is injectable, so the protocol is exercised in Node.
 */

import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../copcChunkDecode';
import {
  DecodeWorkerPool,
  type DecodePoolStats,
  type WorkerLike,
} from '../../workerPool/DecodeWorkerPool';
import { resolveDecodePoolSize } from '../../workerPool/decodePoolSize';
import { readDevFlags } from '../../../perf/devFlags';

export type { WorkerLike };

/** Create the real module worker. Browser-only — never called in Node tests. */
function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./copcWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export interface CopcWorkerClientOptions {
  /**
   * Explicit worker count. Both opts into pooling and overrides the device
   * policy, clamped to the policy's hard cap. Tests pin it so a pool's
   * behaviour does not depend on the core count of the machine running them.
   */
  readonly poolSize?: number;
  /** Injectable worker factory — a fake worker makes the pool Node-testable. */
  readonly workerFactory?: () => WorkerLike;
}

/** A `ChunkDecoder` that runs COPC chunk decoding in a pool of workers. */
export class CopcWorkerClient implements ChunkDecoder {
  private readonly _pool: DecodeWorkerPool<DecodedChunk>;

  constructor(options: CopcWorkerClientOptions = {}) {
    this._pool = new DecodeWorkerPool<DecodedChunk>({
      size: resolveDecodePoolSize('copc', readDevFlags(), options.poolSize),
      createWorker: options.workerFactory ?? defaultWorkerFactory,
      messages: {
        disposed: 'The COPC decode worker has been disposed.',
        failed: 'The COPC decode worker failed.',
        aborted: 'Decode aborted',
        queueFull: 'The COPC decode queue is full.',
      },
    });
  }

  /**
   * Optional hook called after each successful decode with the time the chunk
   * spent INSIDE a worker (post to reply). The streaming benchmark wires this.
   * Queue wait is reported separately by {@link onQueueWaitMs} so a benchmark
   * never reads scheduling delay as decode cost.
   */
  get onDecodeMs(): ((ms: number) => void) | undefined {
    return this._pool.onDecodeMs;
  }
  set onDecodeMs(hook: ((ms: number) => void) | undefined) {
    this._pool.onDecodeMs = hook;
  }

  /** Optional hook called with the time a chunk waited for a free worker. */
  get onQueueWaitMs(): ((ms: number) => void) | undefined {
    return this._pool.onQueueWaitMs;
  }
  set onQueueWaitMs(hook: ((ms: number) => void) | undefined) {
    this._pool.onQueueWaitMs = hook;
  }

  /** In-flight request count — queued plus decoding. Diagnostic. */
  get pendingCount(): number {
    return this._pool.pendingCount;
  }

  /** Pool diagnostics. Plain numbers; no worker handle reaches the caller. */
  poolStats(): DecodePoolStats {
    return this._pool.stats();
  }

  /**
   * Decode a compressed COPC node chunk. The `chunk` buffer is transferred to
   * a worker — the caller must not reuse it after the call. The pool transfers
   * it exactly once, and never re-posts a chunk whose buffer has already gone.
   */
  decode(
    chunk: ArrayBuffer,
    meta: ChunkDecodeMetadata,
    signal?: AbortSignal,
  ): Promise<DecodedChunk> {
    return this._pool.submit({ payload: { chunk, meta }, transfer: [chunk], signal });
  }

  /** Terminate every worker and reject every queued and in-flight decode. */
  dispose(): void {
    this._pool.dispose();
  }
}
