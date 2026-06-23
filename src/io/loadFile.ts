import { createSerialGate } from './serialGate';
import { sniffFormat } from './sniffFormat';
import type { SourceFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import type { LoadResult } from './parseBuffer';
import { POINT_BUDGET } from './parseBuffer';
import { parseLasHeader, LAS_DECODED_ATTRIBUTES } from './lasHeader';
import {
  planLoad,
  NON_STREAMING_FORMATS,
  LARGE_NON_LAS_THRESHOLD_BYTES,
  LARGE_STATIC_LAS_THRESHOLD_BYTES,
} from './loadPlan';
import type { LoadPlan } from './loadPlan';
import { formatByteSize } from './formatByteSize';
import type { ProgressUpdate } from './loadProgress';
import type { LoadTelemetry } from './loadTelemetry';
import { formatInfo } from './formatInfo';
import type { SourceMetadata } from './PointCloudSource';
import { buildPreloadSummary } from './preloadSummary';
import { LoadError } from './loadErrors';
import type { LoadErrorCategory } from './loadErrors';

export type { LoadResult, LoaderFn } from './parseBuffer';
export { POINT_BUDGET, MOBILE_POINT_BUDGET, pickLoader, parseBuffer } from './parseBuffer';
export type { LoadStage, ProgressUpdate } from './loadProgress';

/**
 * Bytes read from the head of a file to detect its format and, for LAS/LAZ,
 * to read the public header AND the LASF_Projection VLR(s) that follow it.
 * The LAS public header is at most 375 bytes; a typical CRS VLR adds 54 +
 * 1–3 KB of WKT (the OGC string), and the GeoTIFF tag VLR triple adds
 * another ~1 KB. 16 KB covers every real-world LAS/LAZ header + VLR set
 * with comfortable margin while staying a microsecond-scale read on local
 * files and an inconsequential ~12 KB extra over HTTP for remote files —
 * which spares us a second range request for VLR re-parsing.
 */
const HEAD_SLICE_BYTES = 16384;

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
   * Multi-line preload summary, emitted once the format has been detected —
   * the format, the source size, the point count where the header reveals one,
   * and how the file will be loaded. Shown for every format, before the decode.
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
  | { type: 'error'; error: string; category?: LoadErrorCategory }
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

/**
 * A file's detected format plus, for LAS/LAZ, its budget-aware load plan, and
 * for PTS the point count read from its optional header line.
 */
interface FilePreflight {
  format: SourceFormat;
  plan?: LoadPlan;
  /** Point count from a header that exposes one without a plan (PTS). */
  headerPointCount?: number;
  /**
   * True for a large non-LAS/LAZ file (E57/PLY/PTS/PTX/OBJ/GLB/XYZ…). Those
   * loaders decode the whole point set in memory before downsampling, so a big
   * file means a real RAM spike at decode. LAS/LAZ carries the same signal on
   * its `plan`; this field carries it for the non-LAS formats whose preflight
   * has no plan, so the warning reaches the user for the formats it is about.
   */
  largeNonLasFormat?: boolean;
  /**
   * True for a large NON-COPC static LAS/LAZ. It strides at decode (bounded
   * display) but the whole file is still read into one ArrayBuffer first, so a
   * multi-GB file is a real RAM risk worth a pre-read caution. COPC is routed to
   * the streaming reader upstream and never reaches this preflight.
   */
  largeStaticLas?: boolean;
}

/**
 * A PTS file may open with a lone-integer point count on its first line. Read
 * it from the head slice when present — it lets the preload summary show a
 * count for PTS, the one text format whose header reveals one. Returns
 * `undefined` when the first line is not a bare non-negative integer.
 */
function readPtsHeaderCount(headSlice: ArrayBuffer): number | undefined {
  const prefix = new Uint8Array(headSlice, 0, Math.min(64, headSlice.byteLength));
  const firstLine = new TextDecoder().decode(prefix).split('\n', 1)[0].trim();
  if (!/^\d+$/.test(firstLine)) return undefined;
  const count = Number(firstLine);
  return Number.isSafeInteger(count) ? count : undefined;
}

/**
 * Cheap preflight — read a small head slice, detect the format, and read what
 * the header reveals: a budget-aware load plan for LAS/LAZ, a point count for
 * PTS. No file body is decoded. Throws a typed `LoadError` when the format is
 * unrecognised.
 */
async function preflightFile(
  file: File,
  budget: number,
  options: LoadOptions,
): Promise<FilePreflight> {
  const headSlice = await file.slice(0, HEAD_SLICE_BYTES).arrayBuffer();
  const format = sniffFormat(headSlice, file.name);
  if (format === 'unknown') {
    throw new LoadError(
      'unsupported-format',
      `Unrecognised file format: ${file.name}`,
    );
  }
  const preflight: FilePreflight = { format };
  if (format === 'las' || format === 'laz') {
    preflight.plan = buildLasPlan(headSlice, format, file.size, budget, options);
  } else if (format === 'pts') {
    preflight.headerPointCount = readPtsHeaderCount(headSlice);
  }
  // Non-LAS formats have no budget plan, so they never reach `planLoad`'s
  // large-file check. Compute the same signal here so the pre-decode RAM
  // warning actually fires for the formats it describes (E57/PLY/PTS/…).
  if (NON_STREAMING_FORMATS.has(format) && file.size > LARGE_NON_LAS_THRESHOLD_BYTES) {
    preflight.largeNonLasFormat = true;
  }
  // A multi-GB non-COPC LAS/LAZ strides at decode but is still materialised in
  // full first — caution the user toward COPC/EPT before the read.
  if ((format === 'las' || format === 'laz') && file.size > LARGE_STATIC_LAS_THRESHOLD_BYTES) {
    preflight.largeStaticLas = true;
  }
  return preflight;
}

/**
 * Assemble the source metadata — the cheap preflight result the UI shows — from
 * a finished preflight. Shared by `fileMetadata` and `loadFile` so both surface
 * exactly the same facts without a second head-slice read.
 */
function buildSourceMetadata(file: File, preflight: FilePreflight): SourceMetadata {
  const { format, plan, headerPointCount } = preflight;
  const meta: SourceMetadata = {
    format,
    label: formatInfo(format).label,
    byteSize: file.size,
  };
  if (plan) {
    meta.estimatedPointCount = plan.sourceCount;
    meta.loadModeSummary =
      plan.mode === 'all' ? 'Standard load' : 'Large-file optimization enabled';
  } else if (headerPointCount !== undefined) {
    meta.estimatedPointCount = headerPointCount;
  }
  // Surface the pre-decode RAM caution. LAS/LAZ carries it on the plan; non-LAS
  // formats carry it on `preflight.largeNonLasFormat` (set above). Either way
  // the user sees it before the expensive parse, not after a silent OOM.
  if (preflight.largeNonLasFormat || plan?.largeNonLasFormat) {
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — this format ` +
      `decodes fully in memory before downsampling, so the load may spike RAM. ` +
      `LAS/LAZ stream more gently.`;
  } else if (preflight.largeStaticLas) {
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — the whole file is ` +
      `read into memory before display. For multi-GB datasets, convert to COPC or EPT for ` +
      `progressive, bounded-memory streaming.`;
  }
  return meta;
}

/**
 * The cheap source-metadata preflight behind `LocalFileSource.metadata()` — the
 * detected format, its label, the file size, and (for formats whose header
 * reveals it) the point count and chosen load mode. Decodes no file body.
 */
export async function fileMetadata(
  file: File,
  options: LoadOptions = {},
): Promise<SourceMetadata> {
  const budget = options.budget ?? POINT_BUDGET;
  const preflight = await preflightFile(file, budget, options);
  return buildSourceMetadata(file, preflight);
}

// --- Persistent parse worker ------------------------------------------------
// One long-lived worker is reused across loads so the laz-perf WASM module
// (memoised inside it) survives between files. It is created lazily on first
// use and re-created if a previous one was dropped after a worker-level error
// or a cancellation.
let sharedWorker: Worker | undefined;

// Serialises shared-worker use across concurrent loadFile() calls. The parse
// worker is single-threaded and its `onmessage` handler is assigned per-load,
// so two overlapping loads on the same worker would clobber each other's
// handler — one would hang and the other resolve with the wrong cloud. Each
// load waits its turn before touching the worker.
const workerGate = createSerialGate();

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

  // --- Preflight: detect the format and read what its header reveals. ---
  onProgress?.({ stage: 'detecting-format' });
  const preflight = await preflightFile(file, budget, options);
  const { format, plan } = preflight;
  throwIfCancelled();
  // The universal preload summary — shown for every format, before the decode.
  onPreload?.(buildPreloadSummary(buildSourceMetadata(file, preflight)));
  const sniffMs = performance.now() - startedAt;

  // --- Now read the whole file — only once the format is known. ---
  onProgress?.({ stage: 'reading-file' });
  const readStartedAt = performance.now();
  const buffer = await file.arrayBuffer();
  const fileReadMs = performance.now() - readStartedAt;
  throwIfCancelled();

  // Acquire the worker gate so this load has exclusive use of the shared parse
  // worker; release it in `finally` so a throw anywhere below can't stall the
  // queue. (See `workerGate`.)
  const releaseGate = await workerGate.acquire();
  try {
    throwIfCancelled();
    return await new Promise<LoadResult>((resolve, reject) => {
    const worker = parseWorkerInstance();
    let settled = false;
    let postedAt = 0;
    let transferMs: number | undefined;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      // Remove ourselves from the signal so an aborted load leaves no listener
      // attached (symmetry with `detach`).
      signal?.removeEventListener('abort', onAbort);
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
        // Rebuild the typed LoadError when the worker carried a category, so
        // the toast shows the precise message rather than a text-classified
        // guess. Falls back to a plain Error for untyped worker failures.
        reject(
          msg.category ? new LoadError(msg.category, msg.error) : new Error(msg.error),
        );
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
  } finally {
    releaseGate();
  }
}
