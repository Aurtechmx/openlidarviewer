/**
 * Parse worker — runs a loader plus any voxel-downsampling off the main
 * thread, then transfers the resulting typed arrays back so a large survey
 * never blocks the UI.
 */
import type { DetectedFormat } from './sniffFormat';
import { parseBuffer } from './parseBuffer';

interface ParseRequest {
  buffer: ArrayBuffer;
  format: DetectedFormat;
  name: string;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent): void => {
  const { buffer, format, name } = event.data as ParseRequest;

  void (async (): Promise<void> => {
    try {
      ctx.postMessage({ type: 'progress', text: `Reading ${name}…` });
      const { cloud, originalPointCount, downsampled } = await parseBuffer(buffer, format, name);

      const transfer: ArrayBuffer[] = [cloud.positions.buffer as ArrayBuffer];
      if (cloud.colors) transfer.push(cloud.colors.buffer as ArrayBuffer);
      if (cloud.intensity) transfer.push(cloud.intensity.buffer as ArrayBuffer);
      if (cloud.classification) transfer.push(cloud.classification.buffer as ArrayBuffer);

      ctx.postMessage(
        {
          type: 'done',
          cloud: {
            positions: cloud.positions,
            colors: cloud.colors,
            intensity: cloud.intensity,
            classification: cloud.classification,
            origin: cloud.origin,
            sourceFormat: cloud.sourceFormat,
            name: cloud.name,
            declaredPointCount: cloud.declaredPointCount,
            metadata: cloud.metadata,
          },
          originalPointCount,
          downsampled,
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
