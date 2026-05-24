/**
 * Parse worker — runs a loader plus any voxel-downsampling off the main
 * thread, then transfers the resulting typed arrays back so a large survey
 * never blocks the UI. It also forwards staged-progress events and times its
 * own stages for the debug telemetry.
 */
import type { DetectedFormat } from './sniffFormat';
import { parseBuffer } from './parseBuffer';
import type { LoadPlan } from './loadPlan';
import type { ProgressUpdate, LoadStage } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';

interface ParseRequest {
  buffer: ArrayBuffer;
  format: DetectedFormat;
  name: string;
  /** Optional point budget — phones pass a lower value than the desktop default. */
  budget?: number;
  /** Optional budget-aware load plan — present for LAS/LAZ (see `loadPlan`). */
  plan?: LoadPlan;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent): void => {
  const { buffer, format, name, budget, plan } = event.data as ParseRequest;

  void (async (): Promise<void> => {
    try {
      const startedAt = performance.now();
      // First time each stage is seen, so the decode/downsample split is timed.
      const stageAt = new Map<LoadStage, number>();

      ctx.postMessage({ type: 'progress', stage: 'parsing-metadata' });
      const { cloud, originalPointCount, downsampled } = await parseBuffer(
        buffer,
        format,
        name,
        budget,
        plan,
        (update: ProgressUpdate) => {
          if (!stageAt.has(update.stage)) stageAt.set(update.stage, performance.now());
          // Forward each staged-progress update to the main thread.
          ctx.postMessage({ type: 'progress', ...update });
        },
      );

      const endedAt = performance.now();
      const decodeAt = stageAt.get('decoding');
      const optimizeAt = stageAt.get('optimizing');
      const telemetry: LoadTelemetry = {
        parseMs: decodeAt !== undefined ? decodeAt - startedAt : undefined,
        decodeMs:
          decodeAt !== undefined ? (optimizeAt ?? endedAt) - decodeAt : undefined,
        downsampleMs: optimizeAt !== undefined ? endedAt - optimizeAt : undefined,
      };

      const transfer: ArrayBuffer[] = [cloud.positions.buffer as ArrayBuffer];
      if (cloud.colors) transfer.push(cloud.colors.buffer as ArrayBuffer);
      if (cloud.intensity) transfer.push(cloud.intensity.buffer as ArrayBuffer);
      if (cloud.classification) transfer.push(cloud.classification.buffer as ArrayBuffer);
      if (cloud.normals) transfer.push(cloud.normals.buffer as ArrayBuffer);

      ctx.postMessage(
        {
          type: 'done',
          cloud: {
            positions: cloud.positions,
            colors: cloud.colors,
            intensity: cloud.intensity,
            classification: cloud.classification,
            normals: cloud.normals,
            origin: cloud.origin,
            sourceFormat: cloud.sourceFormat,
            name: cloud.name,
            declaredPointCount: cloud.declaredPointCount,
            metadata: cloud.metadata,
          },
          originalPointCount,
          downsampled,
          telemetry,
        },
        transfer,
      );
    } catch (err) {
      ctx.postMessage({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};
