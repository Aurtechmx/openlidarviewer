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
 * POOLING IS ON FOR LARGE FILES ONLY. At or above
 * {@link PARALLEL_DECODE_MIN_POINTS} records {@link decodeLazPooled} engages the
 * pool by default; below it, and absent a flag, it returns null without building
 * a worker and the loader stays on the historical main-thread `decodeLaz`.
 * `?decodePool=on` opts a smaller file in at the policy's size,
 * `?decodeWorkers=N` pins the count, `?decodePool=off` refuses pooling outright,
 * and the `poolSize` option is the same switch for tests. What makes the default
 * defensible where COPC's and EPT's is not is that the chunked decode is
 * byte-for-byte the legacy output — the same records through the same
 * `decodeRecord` — so the only thing the flag changes is how long it takes.
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
import { resolveDecodePoolSize, decodeLazPoolEnabled } from '../../workerPool/decodePoolSize';
import { readDevFlags } from '../../../perf/devFlags';
import { ArrayBufferRangeSource } from '../../range/ArrayBufferRangeSource';
import type { RangeSource } from '../../range/RangeSource';
import type { RawPoints } from '../../lasDecodeShared';
import type { LasHeader } from '../../lasHeader';
import type { ProgressUpdate } from '../../loadProgress';
import {
  decodeLazParallel, decodeLazParallelFromSource, type DecodePlanInfo,
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
  /**
   * Engage the pool at the device policy's size without pinning a count — what
   * the whole-file LAZ path passes when a file is large enough to decode across
   * workers by default. Equivalent to `?decodePool=on` for this client only;
   * `?decodePool=off` still wins.
   */
  readonly poolEnabled?: boolean;
  /** Injectable worker factory — a fake worker makes the pool Node-testable. */
  readonly workerFactory?: () => WorkerLike;
}

/** A {@link LazChunkDecoder} that runs LAZ chunk decoding in a pool of workers. */
export class LazChunkWorkerClient {
  private readonly _pool: DecodeWorkerPool<RawPoints>;

  constructor(options: LazChunkWorkerClientOptions = {}) {
    const flags = readDevFlags();
    this._pool = new DecodeWorkerPool<RawPoints>({
      size: resolveDecodePoolSize(
        'laz',
        options.poolEnabled ? { ...flags, decodePool: true } : flags,
        options.poolSize,
      ),
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
 * Point count at which a `.laz` decodes across the pool without being asked to.
 *
 * Pooling costs one laz-perf WASM heap per worker plus the worker startup:
 * about 55 ms for the four the hard cap allows, measured in Node threads, and
 * no more in a browser module Worker once its script is fetched. The pool is
 * repaid from a quarter million points in threads; in the browser it decodes
 * a 1 M-point file in 183 ms against 433 ms on one reader, 2 M in 314 against
 * 841, and 10 M in 1.25 s against 3.9 s (headless Chromium, 14-core laptop,
 * `tests/e2e/localOpenDevice.spec.ts`). One million is the smallest rung the
 * browser measured; below it the single reader's whole decode is under half a
 * second and the gain shrinks toward the pool's fixed cost.
 *
 * Deliberately the DECLARED record count, not the sampled one: a strided decode
 * still decompresses every record (laz-perf cannot skip), so the file's size is
 * what the work is proportional to.
 */
export const PARALLEL_DECODE_MIN_POINTS = 1_000_000;

/** Options for {@link decodeLazPooled}; same decode contract as `decodeLaz`. */
export interface PooledDecodeOptions {
  /** Keep one record per bucket of `stride` (1 = every record). */
  readonly stride?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (u: ProgressUpdate) => void;
  /** A stratified subset decoded first; see `decodeLazParallel`. */
  readonly onPreview?: (preview: RawPoints) => void;
  /** Called once the chunk table is read; see `decodeLazParallel`. */
  readonly onPlanned?: (info: DecodePlanInfo) => void;
  /** Called after the decode with the pool the file ran on. */
  readonly onPool?: (stats: { readonly workers: number }) => void;
  /**
   * Called when the pool engaged but could not produce the cloud because no
   * worker of it could be built or kept; the caller then decodes without it.
   */
  readonly onFallback?: (reason: string) => void;
}

/**
 * Decode a whole `.laz` across a worker pool, or return null to let the caller
 * fall back to the main-thread `decodeLaz`.
 *
 * A file of at least {@link PARALLEL_DECODE_MIN_POINTS} records takes this path
 * by default — that is the one place pooled decoding is not opt-in, because the
 * chunked decode is byte-for-byte the legacy result (same records, same order,
 * same shared `decodeRecord`) and the alternative is a minute of one core.
 * Smaller files still need `?decodePool=on` or `?decodeWorkers=N`, and
 * `?decodePool=off` puts any session back on `decodeLaz`. When the pool is not
 * engaged this returns null WITHOUT building a worker.
 *
 * Fails closed the same way in every other respect: {@link decodeLazParallel}
 * returns null (and the pool never spins a worker) for any file whose chunk
 * table this path cannot describe — a pointwise-compressed LAZ, an unsupported
 * record format, a count mismatch. The pool is disposed in every exit, including
 * a decode error, which then propagates so the caller sees the same failure
 * `decodeLaz` would raise rather than a silent slow success.
 */
export function decodeLazPooled(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  options: PooledDecodeOptions = {},
): Promise<RawPoints | null> {
  return decodeLazPooledFromSource(new ArrayBufferRangeSource(buffer), header, origin, options);
}

/** {@link decodeLazPooled} over any range source; chunks are read as needed. */
export async function decodeLazPooledFromSource(
  source: RangeSource,
  header: LasHeader,
  origin: [number, number, number],
  options: PooledDecodeOptions = {},
): Promise<RawPoints | null> {
  const eligible = header.pointCount >= PARALLEL_DECODE_MIN_POINTS;
  if (!decodeLazPoolEnabled(readDevFlags(), eligible)) return null;
  const client = new LazChunkWorkerClient({ poolEnabled: true });
  const flags = readDevFlags();
  try {
    const out = await decodeLazParallelFromSource(source, header, origin, client.decode, {
      stride: options.stride,
      signal: options.signal,
      onProgress: options.onProgress,
      onPreview: options.onPreview,
      onPlanned: options.onPlanned,
      previewChunks: flags.previewChunks ?? undefined,
    });
    options.onPool?.({ workers: client.poolStats().size });
    return out;
  } catch (err) {
    // A pool with no worker left (none could be built, or every one failed)
    // is an environment fact, not a decode fault: the caller decodes without
    // it and the reason is reported, never swallowed.
    if (client.poolStats().broken && !options.signal?.aborted) {
      options.onFallback?.(err instanceof Error ? err.message : String(err));
      return null;
    }
    throw err;
  } finally {
    client.dispose();
  }
}
