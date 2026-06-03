/**
 * TerrainJob.ts
 *
 * A typed handle to one in-flight terrain analysis. The host
 * subscribes for progress + completion; cancelling drops the worker
 * mid-walk via the abort signal.
 */

import type { TerrainAnalysisRequest, TerrainAnalysisResult, TerrainJobStatus } from './TerrainContracts';
import type { TerrainProgress } from './TerrainProgress';

/** A job handle. */
export interface TerrainJob {
  readonly id: string;
  readonly request: TerrainAnalysisRequest;
  readonly status: TerrainJobStatus;
  /** Resolves with the result when the job completes / fails / cancels. */
  readonly promise: Promise<TerrainAnalysisResult>;
  /** Subscribe to progress updates. Returns an unsubscribe handle. */
  readonly onProgress: (cb: (p: TerrainProgress) => void) => () => void;
  /** Abort the job — flips status to `'cancelled'`. */
  readonly cancel: () => void;
}
