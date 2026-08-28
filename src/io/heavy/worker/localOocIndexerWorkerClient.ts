/**
 * localOocIndexerWorkerClient.ts — drive the out-of-core LAS indexer worker.
 *
 * The index build reads a multi-gigabyte LAS as bounded slices and settles it
 * into an OPFS tile store. That work belongs off the main thread for two
 * reasons: it is CPU-heavy over the whole file, and the fast OPFS write
 * primitive (`FileSystemSyncAccessHandle`) is exposed only inside a worker. So
 * the main thread posts the `File` here — a `File` is structured-cloneable, so
 * it crosses the worker boundary without a copy of its bytes — and the worker
 * opens its own OPFS root, builds the store, and posts back the two text
 * artifacts plus the promoted store's name. Nothing live crosses back: the
 * caller reopens the tiles from OPFS by name.
 *
 * This module holds the `new Worker(new URL(...))` literal, so it is registered
 * in `src/workers/workerRegistry.ts` as a worker client and excluded from the
 * live source transform (a transform that scrambled the specifier would 404 the
 * chunk at runtime, the #266 defect).
 */
import type { LocalOocBuildResult, LocalOocPhase } from '../localOocBuild';

/** What the caller asks the worker to build. */
export interface LocalOocIndexRequest {
  readonly file: File;
  /** The OPFS directory name the finished store is promoted to. */
  readonly storeName: string;
  /** Which builder to run: the sliced-LAS reader or the chunked-LAZ source.
   *  Optional and defaults to 'las' so an older caller keeps its behaviour. */
  readonly kind?: 'las' | 'laz';
  readonly pointsPerLeaf?: number;
  readonly memoryBudgetBytes?: number;
  readonly maxDepth?: number;
  readonly batchPoints?: number;
  readonly onPhase?: (phase: LocalOocPhase) => void;
  readonly signal?: AbortSignal;
}

/** The build options that cross the boundary — no callbacks, no signal. */
export interface LocalOocIndexOptions {
  readonly kind?: 'las' | 'laz';
  readonly pointsPerLeaf?: number;
  readonly memoryBudgetBytes?: number;
  readonly maxDepth?: number;
  readonly batchPoints?: number;
}

/** main → worker. */
export type LocalOocRequestMessage =
  | { readonly type: 'build'; readonly file: File; readonly storeName: string; readonly options: LocalOocIndexOptions }
  | { readonly type: 'cancel' };

/** worker → main. */
export type LocalOocResponseMessage =
  | { readonly type: 'phase'; readonly phase: LocalOocPhase }
  | { readonly type: 'done'; readonly result: LocalOocBuildResult }
  | { readonly type: 'error'; readonly message: string; readonly name?: string };

/**
 * Runs one out-of-core index build in a dedicated worker.
 *
 * One build per instance: the worker is created on {@link run} and terminated
 * when it resolves, rejects or is aborted, so a cancelled index frees its worker
 * and its OPFS locks promptly rather than lingering for the session.
 */
export class LocalOocIndexerClient {
  run(request: LocalOocIndexRequest): Promise<LocalOocBuildResult> {
    const worker = new Worker(new URL('./localOocIndexerWorker.ts', import.meta.url), {
      type: 'module',
    });

    return new Promise<LocalOocBuildResult>((resolve, reject) => {
      const onAbort = (): void => {
        // Ask the worker to abort its build; it discards the partial store and
        // posts an error, which settles this promise through onmessage below.
        worker.postMessage({ type: 'cancel' } satisfies LocalOocRequestMessage);
      };
      const cleanup = (): void => {
        request.signal?.removeEventListener('abort', onAbort);
        worker.terminate();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (event: MessageEvent<LocalOocResponseMessage>): void => {
        const message = event.data;
        if (message.type === 'phase') {
          request.onPhase?.(message.phase);
          return;
        }
        if (message.type === 'done') {
          cleanup();
          resolve(message.result);
          return;
        }
        cleanup();
        reject(Object.assign(new Error(message.message), message.name ? { name: message.name } : {}));
      };
      worker.onerror = (event: ErrorEvent): void => {
        cleanup();
        reject(new Error(event.message || 'out-of-core indexer worker failed'));
      };

      worker.postMessage({
        type: 'build',
        file: request.file,
        storeName: request.storeName,
        options: {
          kind: request.kind,
          pointsPerLeaf: request.pointsPerLeaf,
          memoryBudgetBytes: request.memoryBudgetBytes,
          maxDepth: request.maxDepth,
          batchPoints: request.batchPoints,
        },
      } satisfies LocalOocRequestMessage);
    });
  }
}
