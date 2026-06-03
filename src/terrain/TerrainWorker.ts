/**
 * TerrainWorker.ts
 *
 * Worker infrastructure for terrain analyses. v0.3.9 ships the
 * orchestrator + protocol; the actual Web Worker module bundles in
 * a later release. The orchestrator runs the work either in a
 * Worker (when `terrainWorkerEnabled` is true and the host registers
 * a worker factory) or inline on the main thread (the fallback).
 *
 * Job lifecycle:
 *
 *   queued → running → completed
 *   queued → running → cancelled
 *   queued → running → failed
 *
 * Cancellation is honoured at every chunk boundary, so a long walk
 * dropped mid-flight stops promptly and the cleanup hook fires.
 */

import type { TerrainAnalysisRequest, TerrainAnalysisResult, TerrainJobStatus } from './TerrainContracts';
import { TerrainCancelledError, TerrainError } from './TerrainErrors';
import type { TerrainJob } from './TerrainJob';
import type { TerrainProgress } from './TerrainProgress';

/** Function the orchestrator calls to actually run the analysis. */
export type TerrainAnalyser = (
  request: TerrainAnalysisRequest,
  reportProgress: (p: TerrainProgress) => void,
  abortSignal: AbortSignal,
) => Promise<TerrainAnalysisResult>;

/** Build a freshly-tracked job. */
export function createTerrainJob(
  id: string,
  request: TerrainAnalysisRequest,
  analyser: TerrainAnalyser,
): TerrainJob {
  let status: TerrainJobStatus = 'queued';
  const progressListeners = new Set<(p: TerrainProgress) => void>();
  const abort = new AbortController();

  const promise = (async (): Promise<TerrainAnalysisResult> => {
    status = 'running';
    try {
      const result = await analyser(
        request,
        (p) => {
          for (const fn of progressListeners) {
            try {
              fn(p);
            } catch {
              /* defensive */
            }
          }
        },
        abort.signal,
      );
      if (abort.signal.aborted) {
        status = 'cancelled';
        throw new TerrainCancelledError();
      }
      status = 'completed';
      return result;
    } catch (err) {
      if (err instanceof TerrainCancelledError) {
        status = 'cancelled';
        throw err;
      }
      status = 'failed';
      if (err instanceof TerrainError) throw err;
      const msg = err instanceof Error ? err.message : 'Terrain analyser failed.';
      throw new TerrainError('internal', msg);
    } finally {
      progressListeners.clear();
    }
  })();

  return {
    id,
    request,
    get status(): TerrainJobStatus {
      return status;
    },
    promise,
    onProgress: (cb) => {
      progressListeners.add(cb);
      return () => progressListeners.delete(cb);
    },
    cancel: () => {
      if (status === 'queued' || status === 'running') abort.abort();
    },
  };
}
