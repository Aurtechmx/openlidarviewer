/**
 * deriveClassificationWorker.ts
 *
 * Off-thread host for the unsupervised classifier so deriving a class for a
 * multi-million-point cloud never freezes the UI. Mirrors the terrain-core /
 * COPC-decode worker contract:
 *
 *   in  { jobId, positions: ArrayBuffer, n, options }
 *   out { jobId, ok: true,  codes, counts, cellSizeM, gridWidth, gridHeight, provenance }
 *       { jobId, ok: false, error }
 *
 * The positions buffer arrives as an ArrayBuffer (already copied/transferred by
 * the client, so the worker owns it) and is viewed as a Float32Array WITHOUT
 * copying. The derived `codes` buffer is transferred back zero-copy.
 *
 * {@link deriveClassification} is pure (no DOM, no three.js), so it imports
 * cleanly here. The main-thread fallback in {@link deriveClassificationAsync}
 * is the correctness backbone the tests cover; this worker is the
 * responsiveness optimisation.
 */

import { deriveClassification } from './deriveClassification';
import type { DeriveClassificationOptions } from './deriveClassification';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

interface ClassifyMessage {
  jobId: number;
  positions: ArrayBuffer;
  n: number;
  options: DeriveClassificationOptions;
}

ctx.onmessage = (event: MessageEvent<ClassifyMessage>): void => {
  const { jobId, positions, n, options } = event.data;
  try {
    const pos = new Float32Array(positions, 0, n * 3);
    // Post each pipeline phase back as a `progress` message (distinct from the
    // final ok/error reply) so the UI can show a live "deriving…" status.
    const res = deriveClassification(pos, n, options, (phase) => {
      ctx.postMessage({ jobId, phase });
    });
    ctx.postMessage(
      {
        jobId,
        ok: true,
        codes: res.codes,
        counts: res.counts,
        cellSizeM: res.cellSizeM,
        gridWidth: res.gridWidth,
        gridHeight: res.gridHeight,
        provenance: res.provenance,
      },
      [res.codes.buffer],
    );
  } catch (err) {
    ctx.postMessage({
      jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
