/**
 * Parse worker — runs a loader plus any voxel-downsampling off the main
 * thread, then transfers the resulting typed arrays back so a large survey
 * never blocks the UI. It also forwards staged-progress events and times its
 * own stages for the debug telemetry.
 */
import type { DetectedFormat } from './sniffFormat';
import { parseBuffer, parseFile } from './parseBuffer';
import { LoadError } from './loadErrors';
import type { LoadErrorCategory } from './loadErrors';
import type { LoadPlan, E57DecodePlan } from './loadPlan';
import type { ProgressUpdate, LoadStage } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';
import type { PointCloud } from '../model/PointCloud';
import { organizedRangeTransferables } from '../model/OrganizedRange';
import { primeDevFlags } from '../perf/devFlags';
import { primeDecodePoolEnvironment } from './workerPool/decodePoolSize';
import type { LazLoadStats, PreviewSink } from './loadLas';

interface ParseRequest {
  /** The file's bytes, transferred; absent when `file` is sent instead. */
  buffer?: ArrayBuffer;
  /** The file itself, for a format the worker reads as it needs. */
  file?: File;
  /** The page's device answer, which a worker cannot ask `matchMedia` for. */
  device?: { touchFirst: boolean };
  format: DetectedFormat;
  name: string;
  /** Optional point budget — phones pass a lower value than the desktop default. */
  budget?: number;
  /** Optional budget-aware load plan — present for LAS/LAZ (see `loadPlan`). */
  plan?: LoadPlan;
  /**
   * Optional E57 decode plan, built on the main thread from the file's own
   * declaration (see `planE57Decode`). It has to cross the thread boundary
   * because this scope has no `matchMedia`: a plan recomputed inside the worker
   * reads every device as a desktop and can apply a stride the user was never
   * shown.
   */
  e57Plan?: E57DecodePlan;
  /**
   * The page's `location.search`, so the development flags read in this scope
   * (the LAZ pool's opt-in and refusal switches) are the ones the user typed.
   * A worker's own `location` is its script URL and carries no query.
   */
  search?: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent): void => {
  const { buffer, file, format, name, budget, plan, e57Plan, search, device } = event.data as ParseRequest;
  if (typeof search === 'string') primeDevFlags(search);
  if (device) primeDecodePoolEnvironment({ isMobile: device.touchFirst });

  void (async (): Promise<void> => {
    try {
      const startedAt = performance.now();
      // First time each stage is seen, so the decode/downsample split is timed.
      const stageAt = new Map<LoadStage, number>();

      ctx.postMessage({ type: 'progress', stage: 'parsing-metadata' });
      const onProgress = (update: ProgressUpdate): void => {
        if (!stageAt.has(update.stage)) stageAt.set(update.stage, performance.now());
        // Forward each staged-progress update to the main thread.
        ctx.postMessage({ type: 'progress', ...update });
      };
      const onPreview: PreviewSink = (preview, frame) => {
        // A stand-in the main thread shows while the decode runs; it owns
        // its own buffers, so transferring them takes nothing from the final.
        const { payload, transfer } = cloudPayload(preview);
        ctx.postMessage({ type: 'preview', cloud: payload, frame }, transfer);
      };
      let stats: LazLoadStats | undefined;
      const { cloud, originalPointCount, downsampled } = file
        ? await parseFile(file, format, name, budget, plan, onProgress, e57Plan, onPreview, (s) => { stats = s; })
        : await parseBuffer(buffer as ArrayBuffer, format, name, budget, plan, onProgress, e57Plan, onPreview);

      const endedAt = performance.now();
      const decodeAt = stageAt.get('decoding');
      const optimizeAt = stageAt.get('optimizing');
      const telemetry: LoadTelemetry = {
        parseMs: decodeAt !== undefined ? decodeAt - startedAt : undefined,
        decodeMs:
          decodeAt !== undefined ? (optimizeAt ?? endedAt) - decodeAt : undefined,
        downsampleMs: optimizeAt !== undefined ? endedAt - optimizeAt : undefined,
        ...(stats ?? {}),
      };

      const { payload, transfer } = cloudPayload(cloud);
      ctx.postMessage(
        {
          type: 'done',
          cloud: payload,
          originalPointCount,
          downsampled,
          telemetry,
        },
        transfer,
      );
    } catch (err) {
      // Carry the typed category across the thread boundary when the pipeline
      // knew it, so the main thread shows the exact failure message instead of
      // re-deriving the category from the message text (a lossy fallback).
      const reply: { type: 'error'; error: string; category?: LoadErrorCategory } = {
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      if (err instanceof LoadError) reply.category = err.category;
      ctx.postMessage(reply);
    }
  })();
};

/**
 * The cloud as it crosses the thread boundary, with the buffers to transfer
 * rather than clone. Shared by the preview and the final reply so the two can
 * never disagree on which fields travel.
 */
function cloudPayload(cloud: PointCloud): { payload: Record<string, unknown>; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [cloud.positions.buffer as ArrayBuffer];
  if (cloud.colors) transfer.push(cloud.colors.buffer as ArrayBuffer);
  if (cloud.intensity) transfer.push(cloud.intensity.buffer as ArrayBuffer);
  if (cloud.classification) transfer.push(cloud.classification.buffer as ArrayBuffer);
  if (cloud.normals) transfer.push(cloud.normals.buffer as ArrayBuffer);
  if (cloud.returnNumber) transfer.push(cloud.returnNumber.buffer as ArrayBuffer);
  if (cloud.returnCount) transfer.push(cloud.returnCount.buffer as ArrayBuffer);
  if (cloud.pointSourceId) transfer.push(cloud.pointSourceId.buffer as ArrayBuffer);
  if (cloud.gpsTime) transfer.push(cloud.gpsTime.buffer as ArrayBuffer);
  // The organized-range sidecar is several typed arrays PER FRAME, so it is
  // transferred rather than cloned: a 10 M cell grid would otherwise be
  // copied across the boundary, which is the cost this list exists to
  // avoid. Derived from the frames rather than enumerated here, so a new
  // array on a frame cannot quietly fall back to a clone.
  if (cloud.organizedRange) {
    transfer.push(...organizedRangeTransferables(cloud.organizedRange));
  }

  const payload = {
    positions: cloud.positions,
    colors: cloud.colors,
    intensity: cloud.intensity,
    classification: cloud.classification,
    normals: cloud.normals,
    returnNumber: cloud.returnNumber,
    returnCount: cloud.returnCount,
    pointSourceId: cloud.pointSourceId,
    gpsTime: cloud.gpsTime,
    organizedRange: cloud.organizedRange,
    origin: cloud.origin,
    sourceFormat: cloud.sourceFormat,
    name: cloud.name,
    declaredPointCount: cloud.declaredPointCount,
    // v0.5.5 P12 — decodedPointCount was DROPPED at this thread
    // boundary, so the main-thread Health Check fell back to the
    // voxel-reduced display count and flagged every budget-capped
    // load as a declared-vs-decoded anomaly. Carry it (and the
    // deliberate decode stride) across so the check reads the same
    // numbers the worker saw.
    decodedPointCount: cloud.decodedPointCount,
    loadStride: cloud.loadStride,
    metadata: cloud.metadata,
  };
  return { payload, transfer };
}
