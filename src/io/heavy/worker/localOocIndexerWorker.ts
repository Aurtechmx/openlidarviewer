/**
 * localOocIndexerWorker.ts — the worker that indexes a local LAS out of core.
 *
 * A thin wire around {@link handleOocWorkerMessage}: it validates each message
 * (owner origin, well-formed body) before acting on one, then for a build wraps
 * the `File` in a `LocalFileRangeSource` (ranged reads, never a whole-file read),
 * opens the worker's own OPFS root, and runs `buildLocalOocStore` into a partial
 * store that is promoted on success and discarded on cancel or fault. Phase
 * strings and the final result are posted back; a `cancel` message aborts the
 * in-flight build.
 *
 * OPFS sync access handles are worker-only, which is the whole reason the build
 * runs here rather than on the main thread. The build logic is
 * `buildLocalOocStore` and the message handling is `localOocWorkerHandler`, both
 * unit-tested in Node; this file only binds them to the worker global.
 */
/// <reference lib="webworker" />
import { LocalFileRangeSource } from '../../range/LocalFileRangeSource';
import { buildLocalOocStore } from '../localOocBuild';
import type { OpfsDirHandle } from '../opfsSpillStore';
import { handleOocWorkerMessage } from './localOocWorkerHandler';
import type { LocalOocResponseMessage } from './localOocIndexerWorkerClient';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** The controller for the build currently in flight, so `cancel` can abort it. */
let inFlight: AbortController | null = null;

ctx.onmessage = (event: MessageEvent): void => {
  void handleOocWorkerMessage(event, {
    post: (message: LocalOocResponseMessage) => ctx.postMessage(message),
    getController: () => inFlight,
    setController: (controller) => {
      inFlight = controller;
    },
    runBuild: async (message, signal, onPhase) => {
      // The real handle satisfies the structural view the store is written
      // against; TypeScript's lib type is stricter about buffer variance.
      const root = (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;
      const range = new LocalFileRangeSource(message.file);
      return buildLocalOocStore(range, root, message.storeName, {
        kind: message.options.kind,
        pointsPerLeaf: message.options.pointsPerLeaf,
        memoryBudgetBytes: message.options.memoryBudgetBytes,
        maxDepth: message.options.maxDepth,
        batchPoints: message.options.batchPoints,
        signal,
        onPhase,
      });
    },
  });
};
