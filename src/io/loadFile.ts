import { sniffFormat } from './sniffFormat';
import type { SourceFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import type { LoadResult } from './parseBuffer';

export type { LoadResult, LoaderFn } from './parseBuffer';
export { POINT_BUDGET, MOBILE_POINT_BUDGET, pickLoader, parseBuffer } from './parseBuffer';

/** Called with a short human-readable status while a file loads. */
export type ProgressFn = (text: string) => void;

/** The cloud payload transferred back from the parse worker. */
interface CloudPayload {
  positions: Float32Array;
  colors?: Uint8Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  normals?: Float32Array;
  origin: [number, number, number];
  sourceFormat: SourceFormat;
  name: string;
  declaredPointCount?: number;
  metadata?: CloudMetadata;
}

type WorkerReply =
  | { type: 'progress'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; cloud: CloudPayload; originalPointCount: number; downsampled: boolean };

/**
 * Load a dropped File into a PointCloud.
 *
 * The format is sniffed on the main thread; the parse + downsample then runs
 * in a Web Worker so a large survey never freezes the UI. Nothing leaves the
 * browser — the File is read locally and the worker is local.
 *
 * `budget` caps the point count uploaded to the GPU; callers pass a lower
 * value on phones. When omitted the worker uses the desktop default.
 */
export async function loadFile(
  file: File,
  onProgress?: ProgressFn,
  budget?: number,
): Promise<LoadResult> {
  const buffer = await file.arrayBuffer();
  const format = sniffFormat(buffer, file.name);
  if (format === 'unknown') {
    throw new Error(`Unrecognised file format: ${file.name}`);
  }

  return new Promise<LoadResult>((resolve, reject) => {
    const worker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent): void => {
      const msg = event.data as WorkerReply;
      if (msg.type === 'progress') {
        onProgress?.(msg.text);
        return;
      }
      worker.terminate();
      if (msg.type === 'error') {
        reject(new Error(msg.error));
        return;
      }
      resolve({
        cloud: new PointCloud(msg.cloud),
        originalPointCount: msg.originalPointCount,
        downsampled: msg.downsampled,
      });
    };

    worker.onerror = (event: ErrorEvent): void => {
      worker.terminate();
      reject(new Error(event.message || 'Parse worker failed'));
    };

    // The ArrayBuffer is transferred (not copied) into the worker.
    worker.postMessage({ buffer, format, name: file.name, budget }, [buffer]);
  });
}
