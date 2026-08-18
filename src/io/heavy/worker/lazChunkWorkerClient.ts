/**
 * lazChunkWorkerClient.ts
 *
 * The main-thread client for the local-LAZ chunk-decode workers, and the entry
 * point the loader calls to decode a whole `.laz` across a pool.
 *
 * The client is a thin adapter over {@link DecodeWorkerPool}: it owns the LAZ
 * wire format (`{ type: 'decode', requestId, job }`, the chunk buffer
 * transferred zero-copy) and delegates request-id multiplexing, queueing,
 * dispatch, cancellation, worker-failure isolation and disposal to the pool —
 * the same pool the COPC and EPT clients use, so those rules live in one place.
 *
 * WHY A POOL. A single laz-perf reader decodes a chunked cloud's chunks one at
 * a time, on one core, however many the machine has. Several workers decode in
 * parallel; the cost is one WASM heap each, which is why the size comes from the
 * device-aware policy ({@link resolveDecodePoolSize}) and why workers past the
 * first are created only when there is actually a second chunk to decode.
 *
 * POOLING IS OFF BY DEFAULT, exactly as it is for COPC and EPT. Absent a flag,
 * {@link decodeLazPooled} returns null without building a worker, so the loader
 * stays on the historical main-thread `decodeLaz`. `?decodePool=on` opts in at
 * the policy's size and `?decodeWorkers=N` pins the count; the `poolSize` option
 * is the same switch for tests. It stays opt-in until a browser run on a real
 * dataset measures the throughput win against the memory cost of N WASM heaps.
 *
 * The file-level RGB bit-depth decision is NOT affected by pooling: each worker
 * returns colours STAGED (`colors16`), and `decodeLazParallel` narrows them once
 * on the main thread after every chunk is placed, so a cloud cannot end up
 * rendered at two colour depths.
 *
 * Browser-bound by default (the default factory constructs a `Worker`), but the
 * factory is injectable, so the protocol is exercised in Node.
 */

import {
  DecodeWorkerPool,
  type DecodePoolStats,
  type WorkerLike,
} from '../../workerPool/DecodeWorkerPool';
import { resolveDecodePoolSize, decodePoolOptedIn } from '../../workerPool/decodePoolSize';
import { readDevFlags } from '../../../perf/devFlags';
import type { RawPoints } from '../../lasDecodeShared';
import type { LasHeader } from '../../lasHeader';
import {
  decodeLazParallel,
  type LazChunkDecoder,
  type LazChunkJob,
} from '../decodeLazChunked';

export type { WorkerLike };

/** Create the real module worker. Browser-only — never called in Node tests. */
function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL('./lazChunkWorker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as WorkerLike;
}

export interface LazChunkWorkerClientOptions {
  /**
   * Explicit worker count. Both opts into pooling and overrides the device
   * policy, clamped to the policy's hard cap. Tests pin it so a pool's
   * behaviour does not depend on the core count of the machine running them.
   */
  readonly poolSize?: number;
  /** Injectable worker factory — a fake worker makes the pool Node-testable. */
  readonly workerFactory?: () => WorkerLike;
}

/** A {@link LazChunkDecoder} that runs LAZ chunk decoding in a pool of workers. */
export class LazChunkWorkerClient {
  private readonly _pool: DecodeWorkerPool<RawPoints>;

  constructor(options: LazChunkWorkerClientOptions = {}) {
    this._pool = new DecodeWorkerPool<RawPoints>({
      size: resolveDecodePoolSize('laz', readDevFlags(), options.poolSize),
      createWorker: options.workerFactory ?? defaultWorkerFactory,
      messages: {
        disposed: 'The LAZ decode worker has been disposed.',
        failed: 'The LAZ decode worker failed.',
        aborted: 'Decode aborted',
        queueFull: 'The LAZ decode queue is full.',
      },
    });
  }

  /**
   * Decode one chunk. The `job.chunk` buffer is transferred to a worker — the
   * caller must not reuse it after the call. Bound so it can be passed straight
   * as the {@link LazChunkDecoder} `decodeLazParallel` fans out over.
   */
  readonly decode: LazChunkDecoder = (job: LazChunkJob, signal?: AbortSignal): Promise<RawPoints> =>
    this._pool.submit({ payload: { job }, transfer: [job.chunk], signal });

  /** In-flight request count — queued plus decoding. Diagnostic. */
  get pendingCount(): number {
    return this._pool.pendingCount;
  }

  /** Pool diagnostics. Plain numbers; no worker handle reaches the caller. */
  poolStats(): DecodePoolStats {
    return this._pool.stats();
  }

  /** Terminate every worker and reject every queued and in-flight decode. */
  dispose(): void {
    this._pool.dispose();
  }
}

/**
 * Decode a whole `.laz` across a worker pool, or return null to let the caller
 * fall back to the main-thread `decodeLaz`.
 *
 * Returns null WITHOUT building a worker when pooled decoding is not opted in,
 * so the default `.laz` open is byte-for-byte the historical path. When opted
 * in, it builds a short-lived pool, fans every chunk out through it, and
 * assembles the whole-file `RawPoints`; {@link decodeLazParallel} itself returns
 * null (and the pool never spins a worker) for any file whose chunk table this
 * path cannot describe — a pointwise-compressed LAZ, an unsupported record
 * format, a count mismatch — so those also fall back cleanly. The pool is
 * disposed in every exit, including a decode error, which then propagates so the
 * caller sees the same failure `decodeLaz` would raise rather than a silent
 * slow success.
 */
export async function decodeLazPooled(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  signal?: AbortSignal,
): Promise<RawPoints | null> {
  if (!decodePoolOptedIn(readDevFlags())) return null;
  const client = new LazChunkWorkerClient();
  try {
    return await decodeLazParallel(buffer, header, origin, client.decode, signal);
  } finally {
    client.dispose();
  }
}
