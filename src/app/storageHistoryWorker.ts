/**
 * storageHistoryWorker.ts: runs the storage-grid test (`science/storageHistory.ts`) off the
 * main thread. At its budget the test takes one to two seconds of trigonometry, which is too
 * long for a UI task.
 *
 * Contract:
 *   in  { jobId, request: StorageHistoryRequest }   (the XY buffer is transferred)
 *   out { jobId, ok: true, outcome } | { jobId, ok: false, error }
 *
 * The test is pure and DOM-free, so it imports cleanly here, and the outcome is plain data
 * that structured-clones back unchanged. The same request gives the same outcome here as on
 * the main thread: window choice and the null use fixed seeds.
 */
import { runStorageHistory, type StorageHistoryRequest } from '../science/storageHistory';

export interface StorageHistoryWorkerRequest {
  readonly jobId: number;
  readonly request: StorageHistoryRequest;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<StorageHistoryWorkerRequest>): void => {
  // A dedicated worker only receives messages from the page that created it,
  // where `origin` is empty. Refuse anything that names another origin. The
  // request is read as plain data and the test refuses a malformed one.
  if (event.origin && event.origin !== ctx.location.origin) return;
  const msg = event.data;
  try {
    ctx.postMessage({ jobId: msg.jobId, ok: true, outcome: runStorageHistory(msg.request) });
  } catch (err) {
    ctx.postMessage({ jobId: msg.jobId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
