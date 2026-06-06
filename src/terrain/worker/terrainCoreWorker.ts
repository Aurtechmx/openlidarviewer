/**
 * terrainCoreWorker.ts
 *
 * The terrain-"core" compute worker. The heavy, interval-INDEPENDENT half of
 * the contour pipeline — classification → ground filter → DTM raster +
 * hardening → void fill → hold-out validation + calibration → interval gate →
 * quality + scoring → surface models — runs here, off the main thread, so the
 * UI never freezes on the first Analyse of a large cloud.
 *
 * Contract (mirrors the COPC decode worker):
 *   in  { jobId, positions: ArrayBuffer, n, coreParams, classification? }
 *   out { jobId, ok: true,  core }        — on success
 *       { jobId, ok: false, error }       — on any throw
 *
 * The positions buffer arrives as an ArrayBuffer; the worker rebuilds a
 * Float32Array view over it (length `3·n`) WITHOUT copying — the buffer was
 * already copied/transferred by the client, so the worker owns it. The
 * classification (when present) rides along as its own value (structured-
 * cloned) and is handed straight to {@link computeTerrainCore}.
 *
 * {@link computeTerrainCore} is pure (no DOM, no three.js, no I/O), so it
 * imports cleanly in a worker. The cheap interval stage ({@link contoursFromCore})
 * deliberately stays on the main thread.
 */

import { computeTerrainCore } from '../contour/analyseContours';
import type { TerrainCoreParams } from '../contour/analyseContours';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** Request: a single core computation keyed by a job id. */
interface ComputeMessage {
  jobId: number;
  /** XYZ triples (length 3·n) as a raw buffer; rebuilt into a Float32Array. */
  positions: ArrayBuffer;
  /** Point count (positions has 3·n floats). */
  n: number;
  /** Interval-INDEPENDENT core parameters (no contour interval). */
  coreParams: TerrainCoreParams;
  /** Optional per-point classification, carried separately from coreParams. */
  classification?: ReadonlyArray<number> | Uint8Array;
}

ctx.onmessage = (event: MessageEvent<ComputeMessage>): void => {
  const msg = event.data;
  const { jobId } = msg;
  try {
    // Rebuild the typed-array view over the transferred/cloned buffer. The
    // worker owns this buffer, so the view is safe to read.
    const positions = new Float32Array(msg.positions, 0, msg.n * 3);
    // Re-attach the classification onto the params the core reads. It is carried
    // as a top-level field so the client can choose how to serialise it without
    // mutating the caller's params object.
    const coreParams: TerrainCoreParams =
      msg.classification !== undefined
        ? { ...msg.coreParams, classification: msg.classification }
        : msg.coreParams;
    const core = computeTerrainCore(positions, coreParams);
    // Structured-clone the result back. The core's typed-array grids (DTM,
    // relief, …) clone correctly; correctness over zero-copy here.
    ctx.postMessage({ jobId, ok: true, core });
  } catch (err) {
    ctx.postMessage({
      jobId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
