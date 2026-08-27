/**
 * localOocIndexerWorker.ts — the worker that indexes a local LAS out of core.
 *
 * Receives a `File`, wraps it in a `LocalFileRangeSource` (ranged reads, never a
 * whole-file read), opens the worker's own OPFS root, and runs
 * `buildLocalOocStore` into a partial store that is promoted on success and
 * discarded on cancel or fault. It posts phase strings as the build progresses
 * and the two text artifacts plus the store name when it finishes. A `cancel`
 * message aborts the in-flight build through an `AbortController`.
 *
 * OPFS sync access handles are worker-only, which is the whole reason the build
 * runs here rather than on the main thread. The build logic itself is
 * `buildLocalOocStore`, unit-tested in Node against a fake OPFS; this file is
 * the message transport around it.
 */
/// <reference lib="webworker" />
import { LocalFileRangeSource } from '../../range/LocalFileRangeSource';
import { buildLocalOocStore } from '../localOocBuild';
import type { OpfsDirHandle } from '../opfsSpillStore';
import type {
  LocalOocRequestMessage,
  LocalOocResponseMessage,
} from './localOocIndexerWorkerClient';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** The controller for the build currently in flight, so `cancel` can abort it. */
let inFlight: AbortController | null = null;

function post(message: LocalOocResponseMessage): void {
  ctx.postMessage(message);
}

ctx.onmessage = async (event: MessageEvent<LocalOocRequestMessage>): Promise<void> => {
  const message = event.data;
  if (message.type === 'cancel') {
    inFlight?.abort();
    return;
  }
  if (message.type !== 'build') return;

  const controller = new AbortController();
  inFlight = controller;
  try {
    // The real handle satisfies the structural view the store is written
    // against; TypeScript's lib type is stricter about buffer variance.
    const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
    const range = new LocalFileRangeSource(message.file);
    const result = await buildLocalOocStore(range, root, message.storeName, {
      pointsPerLeaf: message.options.pointsPerLeaf,
      memoryBudgetBytes: message.options.memoryBudgetBytes,
      maxDepth: message.options.maxDepth,
      batchPoints: message.options.batchPoints,
      signal: controller.signal,
      onPhase: (phase) => post({ type: 'phase', phase }),
    });
    post({ type: 'done', result });
  } catch (err) {
    post({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : undefined,
    });
  } finally {
    inFlight = null;
  }
};
