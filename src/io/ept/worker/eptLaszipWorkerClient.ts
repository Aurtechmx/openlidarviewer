/**
 * eptLaszipWorkerClient.ts
 *
 * The main-thread client for the EPT laszip decode workers. The EPT sibling of
 * `copc/worker/copcWorkerClient.ts`, and like it a thin adapter over
 * {@link DecodeWorkerPool}: this file owns the EPT wire format
 * (`{ type: 'decode', requestId, tile, renderOrigin, rgbEightBit }`, the tile
 * buffer transferred zero-copy) and the EPT error wording; the pool owns
 * request-id multiplexing, queueing, dispatch, cancellation, worker-failure
 * isolation, disposal and timing.
 *
 * The EPT chunk decoder (`EptChunkDecoder`) holds one of these and routes the
 * `laszip` data-type through it. It is created lazily by the streaming open
 * path and lives as long as the session.
 *
 * `rgbEightBit` is decided ONCE per dataset on the main thread (the streaming
 * source pins it from the first decoded RGB tile) and passed down per tile. No
 * worker derives its own, so pooling several workers cannot produce a cloud
 * with two colour depths.
 *
 * POOLING IS OFF BY DEFAULT. Absent a flag this client builds a ONE-worker
 * pool, which is behaviourally the pre-pool client. `?decodePool=on` opts in at
 * the device policy's size and `?decodeWorkers=N` pins the count; the
 * `poolSize` option below is the same switch for tests. It stays opt-in until a
 * browser run on a real dataset measures throughput and the memory cost of one
 * laz-perf WASM heap per worker under a fast camera sweep.
 *
 * The workers are created through an injectable factory, so the whole protocol
 * — including the pool's dispatch and failure handling — is unit-tested against
 * fake workers with no browser. The default factory creates the real module
 * worker.
 */

import type { DecodedChunk } from '../../copc/copcChunkDecode';
import {
  DecodeWorkerPool,
  type DecodePoolStats,
  type WorkerLike,
} from '../../workerPool/DecodeWorkerPool';
import { resolveDecodePoolSize } from '../../workerPool/decodePoolSize';
import { readDevFlags } from '../../../perf/devFlags';

/**
 * The minimal `Worker` surface this client uses — lets tests supply a fake.
 * Re-exported from the pool, which is where the protocol that needs it lives.
 */
export type { WorkerLike };

/** Create the real module worker. Browser-only — never called in Node tests. */
function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./eptLaszipWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export interface EptLaszipWorkerClientOptions {
  /**
   * Explicit worker count. Both opts into pooling and overrides the device
   * policy, clamped to the policy's hard cap. Tests pin it so a pool's
   * behaviour does not depend on the core count of the machine running them.
   */
  readonly poolSize?: number;
}

/** Decodes EPT laszip tiles in a pool of workers, off the main thread. */
export class EptLaszipWorkerClient {
  private readonly _pool: DecodeWorkerPool<DecodedChunk>;

  constructor(
    workerFactory: () => WorkerLike = defaultWorkerFactory,
    options: EptLaszipWorkerClientOptions = {},
  ) {
    this._pool = new DecodeWorkerPool<DecodedChunk>({
      size: resolveDecodePoolSize('ept', readDevFlags(), options.poolSize),
      createWorker: workerFactory,
      messages: {
        disposed: 'The EPT laszip decode worker has been disposed.',
        failed: 'The EPT laszip decode worker failed.',
        aborted: 'EPT decode aborted',
        queueFull: 'The EPT laszip decode queue is full.',
      },
    });
  }

  /**
   * Optional hook called after each successful decode with the time the tile
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

  /** Optional hook called with the time a tile waited for a free worker. */
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
   * Decode one complete EPT laszip tile. The `tile` buffer is transferred to a
   * worker — the caller must not reuse it after the call, and the pool
   * transfers it exactly once. `renderOrigin` is the EPT cloud's per-cloud
   * Float64 shift, applied inside the worker. `rgbEightBit` is the
   * dataset-level RGB bit-depth decision (pinned from the first decoded RGB
   * tile), forwarded to the decode core so every tile narrows colour
   * identically.
   */
  decodeTile(
    tile: ArrayBuffer,
    renderOrigin: readonly [number, number, number],
    signal?: AbortSignal,
    rgbEightBit?: boolean,
  ): Promise<DecodedChunk> {
    return this._pool.submit({
      payload: { tile, renderOrigin: [...renderOrigin], rgbEightBit },
      transfer: [tile],
      signal,
    });
  }

  /** Terminate every worker and reject every queued and in-flight decode. */
  dispose(): void {
    this._pool.dispose();
  }
}
