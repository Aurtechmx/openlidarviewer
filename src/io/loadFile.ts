import { sniffFormat } from './sniffFormat';
import type { SourceFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import type { LoadResult } from './parseBuffer';
import { POINT_BUDGET } from './parseBuffer';
import { parseLasHeader, LAS_DECODED_ATTRIBUTES } from './lasHeader';
import { planLoad } from './loadPlan';
import type { LoadPlan } from './loadPlan';
import type { ProgressUpdate } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';

export type { LoadResult, LoaderFn } from './parseBuffer';
export { POINT_BUDGET, MOBILE_POINT_BUDGET, pickLoader, parseBuffer } from './parseBuffer';
export type { LoadStage, ProgressUpdate } from './loadProgress';

/**
 * Bytes read from the head of a file to detect its format and, for LAS/LAZ,
 * to read the public header. The LAS public header is at most 375 bytes, so
 * 4 KB covers it with margin while staying a trivially small read.
 */
const HEAD_SLICE_BYTES = 4096;

/** Thrown when a load is cancelled through its `AbortSignal`. */
export class LoadCancelledError extends Error {
  constructor() {
    super('Load cancelled');
    this.name = 'LoadCancelledError';
  }
}

/** Callbacks a caller can hook into a load. */
export interface LoadCallbacks {
  /** Staged progress while the file is read and decoded. */
  onProgress?: (update: ProgressUpdate) => void;
  /**
   * Multi-line preload summary, emitted once a LAS/LAZ header has been read —
   * the format, the source point count, and how the file will be loaded.
   */
  onPreload?: (lines: string[]) => void;
}

/** Per-device tuning and lifecycle control for a load. */
export interface LoadOptions {
  /** Point budget; defaults to the desktop budget when omitted. */
  budget?: number;
  /** True on phones — tightens the fast-load thresholds. */
  isMobile?: boolean;
  /** `navigator.deviceMemory` in GB, when the browser reports it. */
  deviceMemoryGB?: number;
  /** Abort signal — abort it to cancel the load (rejects `LoadCancelledError`). */
  signal?: AbortSignal;
}

/** The cloud payload transferred back from the parse worker. */
interface CloudPayload {
  positions: Float32Array;
  colors?: Uint8Array;
  intensity?: Uint16Array;
  classification?: Uint8Array;
  normals?: Float32Array;
  returnNumber?: Uint8Array;
  returnCount?: Uint8Array;
  pointSourceId?: Uint16Array;
  gpsTime?: Float64Array;
  origin: [number, number, number];
  sourceFormat: SourceFormat;
  name: string;
  declaredPointCount?: number;
  metadata?: CloudMetadata;
}

type WorkerReply =
  | ({ type: 'progress' } & ProgressUpdate)
  | { type: 'error'; error: string }
  | {
      type: 'done';
      cloud: CloudPayload;
      originalPointCount: number;
      downsampled: boolean;
      telemetry: LoadTelemetry;
    };

/**
 * Read a LAS/LAZ public header from an already-loaded head slice and build a
 * budget-aware load plan. Returns `undefined` if the header will not parse —
 * the worker is then left to report a proper load error; the preflight is
 * informational, never load-blocking.
 */
function buildLasPlan(
  headSlice: ArrayBuffer,
  format: 'las' | 'laz',
  fileBytes: number,
  budget: number,
  options: LoadOptions,
): LoadPlan | undefined {
  try {
    const header = parseLasHeader(headSlice);
    return planLoad({
      sourceCount: header.pointCount,
      fileBytes,
      budget,
      isMobile: options.isMobile ?? false,
      deviceMemoryGB: options.deviceMemoryGB,
      attributes: LAS_DECODED_ATTRIBUTES,
      format,
    });
  } catch {
    // Header unreadable from the slice — no plan; the worker will report the
    // error properly once it tries the full decode.
    return undefined;
  }
}

// --- Persistent parse worker ------------------------------------------------
// One long-lived worker is reused across loads so the laz-perf WASM module
// (memoised inside it) survives between files. It is created lazily on first
// use and re-created if a previous one was dropped after a worker-level error
// or a cancellation.
let sharedWorker: Worker | undefined;

function parseWorkerInstance(): Worker {
  if (!sharedWorker) {
    sharedWorker = new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });
  }
  return sharedWorker;
}

/** Drop the shared worker (terminating it) so the next load starts fresh. */
function dropWorker(worker: Worker): void {
  worker.terminate();
  if (sharedWorker === worker) sharedWorker = undefined;
}

/**
 * Load a dropped File into a PointCloud.
 *
 * The format is detected from a small head slice *before* the whole file is
 * read, so an unsupported file fails fast and never pulls gigabytes into
 * memory. For LAS/LAZ the public header is in that slice, so a preload summary
 * can be shown immediately. The parse + downsample then runs in a Web Worker
 * so a large survey never freezes the UI. The load reports staged progress and
 * can be cancelled mid-flight via `options.signal`. Nothing leaves the browser.
 */
export async function loadFile(
  file: File,
  callbacks: LoadCallbacks = {},
  options: LoadOptions = {},
): Promise<LoadResult> {
  const { onProgress, onPreload } = callbacks;
  const budget = options.budget ?? POINT_BUDGET;
  const signal = options.signal;

  const throwIfCancelled = (): void => {
    if (signal?.aborted) throw new LoadCancelledError();
  };
  throwIfCancelled();
  const startedAt = performance.now();

  // --- Preflight: detect the format from a small head slice. ---
  onProgress?.({ stage: 'detecting-format' });
  const headSlice = await file.slice(0, HEAD_SLICE_BYTES).arrayBuffer();
  throwIfCancelled();
  const format = sniffFormat(headSlice, file.name);
  if (format === 'unknown') {
    throw new Error(`Unrecognised file format: ${file.name}`);
  }

  // For LAS/LAZ the public header sits inside the head slice — read it now to
  // build a load plan and show what the file is and how it will load.
  let plan: LoadPlan | undefined;
  if (format === 'las' || format === 'laz') {
    plan = buildLasPlan(headSlice, format, file.size, budget, options);
    if (plan) onPreload?.(plan.preloadSummary);
  }
  const sniffMs = performance.now() - startedAt;

  // --- Now read the whole file — only once the format is known. ---
  onProgress?.({ stage: 'reading-file' });
  const readStartedAt = performance.now();
  const buffer = await file.arrayBuffer();
  const fileReadMs = performance.now() - readStartedAt;
  throwIfCancelled();

  return new Promise<LoadResult>((resolve, reject) => {
    const worker = parseWorkerInstance();
    let settled = false;
    let postedAt = 0;
    let transferMs: number | undefined;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      // Terminate the worker mid-decode — no orphan, no leak — and drop it so
      // the next load lazily spawns a fresh one.
      dropWorker(worker);
      reject(new LoadCancelledError());
    };

    const detach = (): void => {
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      signal?.removeEventListener('abort', onAbort);
    };

    // A signal aborted between the read and here is honoured immediately.
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (event: MessageEvent): void => {
      if (settled) return;
      const msg = event.data as WorkerReply;
      if (msg.type === 'progress') {
        // The first reply marks the buffer transfer + worker spin-up cost.
        if (transferMs === undefined) transferMs = performance.now() - postedAt;
        onProgress?.({ stage: msg.stage, detail: msg.detail, fraction: msg.fraction });
        return;
      }
      detach();
      if (msg.type === 'error') {
        reject(new Error(msg.error));
        return;
      }
      resolve({
        cloud: new PointCloud(msg.cloud),
        originalPointCount: msg.originalPointCount,
        downsampled: msg.downsampled,
        telemetry: {
          sniffMs,
          fileReadMs,
          transferMs,
          parseMs: msg.telemetry.parseMs,
          decodeMs: msg.telemetry.decodeMs,
          downsampleMs: msg.telemetry.downsampleMs,
          totalLoadMs: performance.now() - startedAt,
        },
      });
    };

    worker.onerror = (event: ErrorEvent): void => {
      if (settled) return;
      detach();
      // A worker-level error can leave the worker in a bad state — drop it.
      dropWorker(worker);
      reject(new Error(event.message || 'Parse worker failed'));
    };

    // The ArrayBuffer is transferred (not copied) into the worker.
    postedAt = performance.now();
    worker.postMessage({ buffer, format, name: file.name, budget, plan }, [buffer]);
  });
}
