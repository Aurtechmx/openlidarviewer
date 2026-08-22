import { createSerialGate } from './serialGate';
import { sniffFormat, is3dTilesName } from './sniffFormat';
import type { SourceFormat } from './sniffFormat';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import type { LoadResult } from './parseBuffer';
import { POINT_BUDGET, parseBuffer } from './parseBuffer';
import { parseLasHeader, lasDecodedAttributes } from './lasHeader';
import {
  planLoad,
  planE57Decode,
  formatPointCount,
  e57TooLargeMessage,
  e57NoPlanMessage,
  NON_STREAMING_FORMATS,
  LARGE_NON_LAS_THRESHOLD_BYTES,
  LARGE_STATIC_LAS_THRESHOLD_BYTES,
} from './loadPlan';
import type { LoadPlan, E57DecodePlan } from './loadPlan';
import type { E57Preflight } from './e57/preflight';
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
      attributes: lasDecodedAttributes(header.pointFormat),
      format,
    });
  } catch {
    // Header unreadable from the slice — no plan; the worker will report the
    // error properly once it tries the full decode.
    return undefined;
  }
}

/** What an E57 declares about itself, plus how it will be decoded. */
export interface E57FilePreflight {
  declared: E57Preflight;
  plan: E57DecodePlan;
}

/**
 * Read an E57's declared facts and plan its decode, without decoding a point.
 *
 * The 48-byte header sits in the head slice already read; it names the XML
 * section, which is fetched as a second small slice — a few tens of KB even on
 * a 600 MB file. That is the E57 equivalent of reading a LAS public header, and
 * it is what lets the preload summary state the real point count and the real
 * memory verdict BEFORE the whole file is pulled into memory.
 *
 * The E57 reader is dynamically imported so it stays in its own lazily-fetched
 * chunk; opening a `.las` must not download the E57 parser.
 *
 * Throws when anything about the declaration will not read. `preflightFile`
 * catches that and records the reason: `fileMetadata` stays non-throwing and
 * describes the file as unopenable, while `loadFile` refuses it, because a file
 * identified as E57 with no established memory plan is not a file to start
 * reading (see `e57Refusal`).
 */
async function buildE57Preflight(
  file: File,
  headSlice: ArrayBuffer,
  options: LoadOptions,
): Promise<E57FilePreflight> {
  const { e57XmlPageRunFromHead, preflightE57FromXmlPages } = await import('./e57/preflight');
  const run = e57XmlPageRunFromHead(headSlice, file.size);
  const pages = await file.slice(run.physicalStart, run.physicalEnd).arrayBuffer();
  const declared = preflightE57FromXmlPages(new Uint8Array(pages), run);
  const plan = planE57Decode({
    sourceCount: declared.recordCount,
    fileBytes: file.size,
    columnsPerRecord: declared.columnsPerRecord,
    attributes: declared.attributes,
    isMobile: options.isMobile ?? false,
    deviceMemoryGB: options.deviceMemoryGB,
  });
  return { declared, plan };
}

/**
 * A file's detected format plus, for LAS/LAZ, its budget-aware load plan, for
 * E57 its declared scan facts and decode plan, and for PTS the point count read
 * from its optional header line.
 */
interface FilePreflight {
  format: SourceFormat;
  plan?: LoadPlan;
  /** E57 only — the declaration and decode plan `buildE57Preflight` produced. */
  e57?: E57FilePreflight;
  /**
   * E57 only. Why `e57` is absent: set exactly when the declaration would not
   * read, so the refusal can name the reason instead of a bare failure.
   */
  e57PreflightError?: string;
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
    if (is3dTilesName(file.name)) {
      throw new LoadError(
        'unsupported-format',
        `3D Tiles / PNTS isn't openable yet — the format is detected by name but ` +
          `user-facing loading is on the roadmap, not shipped. For now use COPC, ` +
          `EPT, or a LAS/LAZ/PLY export.`,
      );
    }
    throw new LoadError(
      'unsupported-format',
      `Unrecognised file format: ${file.name}`,
    );
  }
  const preflight: FilePreflight = { format };
  if (format === 'las' || format === 'laz') {
    preflight.plan = buildLasPlan(headSlice, format, file.size, budget, options);
  } else if (format === 'e57') {
    try {
      preflight.e57 = await buildE57Preflight(file, headSlice, options);
    } catch (err) {
      preflight.e57PreflightError = err instanceof Error ? err.message : String(err);
    }
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
 * The refusal a finished preflight already justifies, or `undefined` when the
 * file may be read.
 *
 * E57 is the one static format whose header states the memory an open needs
 * before the file is read, and `preflightFile` has that verdict in hand two
 * small slices in. Both outcomes below are refusals BEFORE the whole-file read:
 * a plan that does not fit, and a declaration that would not parse. The second
 * is the fail-closed half. An E57 with no plan has no stride and no ceiling
 * check, so reading it is reading unguarded, which is what the guard exists to
 * stop (compare `isLinearUnitKnown()`: a missing value must not read as a
 * known-good one).
 */
function e57Refusal(file: File, preflight: FilePreflight): LoadError | undefined {
  if (preflight.format !== 'e57') return undefined;
  if (!preflight.e57) {
    return new LoadError(
      'malformed-file',
      e57NoPlanMessage(file.name, preflight.e57PreflightError ?? 'no reason recorded'),
    );
  }
  if (!preflight.e57.plan.fits) {
    return new LoadError('memory-constraint', e57TooLargeMessage(file.name, preflight.e57.plan));
  }
  return undefined;
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
  } else if (preflight.e57) {
    // E57's declared record total is read from its XML section, so it can state
    // a real count and a real mode up front exactly as LAS does.
    meta.estimatedPointCount = preflight.e57.plan.sourceCount;
    meta.loadModeSummary =
      preflight.e57.plan.mode === 'all' ? 'Standard load' : 'Large-file optimization enabled';
  } else if (headerPointCount !== undefined) {
    meta.estimatedPointCount = headerPointCount;
  }
  // Surface the pre-decode RAM caution, strongest signal first.
  //
  // `mayExceedCeiling` outranks the size cautions below it because it is a
  // different claim. Those say "this is big, expect a spike" — the open is
  // still expected to succeed. This one says the budget guard already shrank
  // the plan as far as it can and the estimate is STILL over the device's
  // memory ceiling, because the fixed costs (file bytes + LAZ scratch + WASM
  // heap) exceed it on their own. No reshape of the point budget can fix that,
  // so the honest line is that the open may fail, not that it may be slow.
  // Reporting only the ordinary size note here implied the file fits.
  if (preflight.e57PreflightError !== undefined) {
    // The declaration did not read, so there is no plan to describe and the
    // open will be refused. Stating it here is what the user sees before the
    // refusal, and it costs the same two small slices the plan would have.
    meta.warning =
      `${formatInfo(format).label} declaration unreadable — the file header and XML ` +
      `section did not parse, so the memory an open would need cannot be established ` +
      `and the open will be refused. The file may be corrupt or truncated.`;
  } else if (plan?.mayExceedCeiling) {
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — the estimated ` +
      `memory needed is above what this device can be expected to give the tab, even at ` +
      `the smallest load setting. The open may fail. Convert to COPC/EPT (PDAL or ` +
      `untwine) to stream it instead.`;
  } else if (preflight.e57 && !preflight.e57.plan.fits) {
    // Read off the file's own declaration, so this is a verdict rather than a
    // size-based guess: the open WILL be refused, and it says why before the
    // user waits for a multi-hundred-megabyte read.
    meta.warning =
      `${formatInfo(format).label} too large for this device — reading it needs about ` +
      `${formatByteSize(preflight.e57.plan.fullDecodeEstimateBytes)} against a ` +
      `${formatByteSize(preflight.e57.plan.ceilingBytes)} budget, and no sample small ` +
      `enough to fit would be worth showing. Convert to COPC/EPT (PDAL or untwine) to ` +
      `stream it instead.`;
  } else if (preflight.e57 && preflight.e57.plan.stride > 1) {
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — reading every ` +
      `record needs about ${formatByteSize(preflight.e57.plan.fullDecodeEstimateBytes)}, ` +
      `so it will be read as a SAMPLE of one record per ${preflight.e57.plan.stride} ` +
      `(${formatPointCount(preflight.e57.plan.decodedCount)} of ` +
      `${formatPointCount(preflight.e57.plan.sourceCount)} points). Counts and densities ` +
      `will describe the sample. Convert to COPC/EPT (PDAL or untwine) for all of it.`;
  } else if (preflight.largeNonLasFormat || plan?.largeNonLasFormat) {
    // LAS/LAZ carries this one on the plan; non-LAS formats carry it on
    // `preflight.largeNonLasFormat` (set above). Either way the user sees it
    // before the expensive parse, not after a silent OOM.
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — decodes fully in ` +
      `memory, so loading may spike RAM.`;
  } else if (preflight.largeStaticLas) {
    meta.warning =
      `Large ${formatInfo(format).label} (${formatByteSize(file.size)}) — read fully into ` +
      `memory. For multi-GB data, convert to COPC/EPT (PDAL or untwine) for streaming.`;
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

/** Builds the real module worker. Overridable so Node tests can inject a fake. */
type ParseWorkerFactory = () => Worker;
const defaultParseWorkerFactory: ParseWorkerFactory = () =>
  new Worker(new URL('./parseWorker.ts', import.meta.url), { type: 'module' });
let parseWorkerFactory: ParseWorkerFactory = defaultParseWorkerFactory;

function parseWorkerInstance(): Worker {
  sharedWorker ??= parseWorkerFactory();
  return sharedWorker;
}

/**
 * Test seam: swap the parse-worker factory so the worker-routed paths
 * (`loadFile`, `decodeFullViaWorker`) can be exercised with a fake worker in
 * Node. Passing `undefined` restores the real module-worker factory. Drops any
 * live shared worker so the next use spins one up from the new factory. Not
 * used in production.
 */
export function __setParseWorkerFactoryForTests(factory?: ParseWorkerFactory): void {
  parseWorkerFactory = factory ?? defaultParseWorkerFactory;
  if (sharedWorker) {
    sharedWorker.terminate();
    sharedWorker = undefined;
  }
}

/** Drop the shared worker (terminating it) so the next load starts fresh. */
function dropWorker(worker: Worker): void {
  worker.terminate();
  if (sharedWorker === worker) sharedWorker = undefined;
}

/** Chunk size for the abort-aware whole-file read (64 MiB). */
const READ_CHUNK_BYTES = 64 * 1024 * 1024;

/**
 * Read the whole file into one ArrayBuffer in slices, checking `signal` between
 * chunks. `File.arrayBuffer()` is not wired to an abort signal, so on a 3–5 GB
 * static file a cancel could not stop the read until the entire file had been
 * materialised — the exact phase where cancellation matters. Reading by slice
 * makes the cancel window one chunk, not the whole file. A file at or below one
 * chunk takes the single-read path (the cancel window is already tiny and
 * slicing would only add copies).
 */
export async function readWholeFileAbortable(
  file: File,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const total = file.size;
  if (signal?.aborted) throw new LoadCancelledError();
  if (total <= READ_CHUNK_BYTES) return file.arrayBuffer();
  const dest = new Uint8Array(total);
  let offset = 0;
  while (offset < total) {
    if (signal?.aborted) throw new LoadCancelledError();
    const end = Math.min(offset + READ_CHUNK_BYTES, total);
    dest.set(new Uint8Array(await file.slice(offset, end).arrayBuffer()), offset);
    offset = end;
  }
  return dest.buffer;
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

  // --- Refuse here, before a byte of the body is read. ---
  // The E57 memory verdict is knowable from two small slices, and the read
  // below materialises the WHOLE file in one ArrayBuffer. Leaving the refusal
  // to the worker meant a 600 MB file already known not to fit was pulled into
  // memory first, on the device least able to hold it, and only then rejected.
  const refusal = e57Refusal(file, preflight);
  if (refusal) throw refusal;

  // --- Now read the whole file — only once the format is known. ---
  onProgress?.({ stage: 'reading-file' });
  const readStartedAt = performance.now();
  // Abort-aware: a cancel during a multi-gigabyte read stops within one chunk
  // instead of after the whole file has been materialised.
  const buffer = await readWholeFileAbortable(file, signal);
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
        transferMs ??= performance.now() - postedAt;
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
    try {
      // `e57Plan` travels with the request so the worker decodes to the plan
      // this thread built and the preload summary named. The worker global
      // scope has no `matchMedia`, so a worker planning for itself reads a
      // phone as a desktop and can pick a different stride, or none.
      worker.postMessage(
        { buffer, format, name: file.name, budget, plan, e57Plan: preflight.e57?.plan },
        [buffer],
      );
    } catch (err) {
      // A synchronous post failure — a DataCloneError on an unclonable or
      // already-detached buffer. Left unguarded the throw escapes this executor
      // and rejects the caller, but `detach` never runs, so `onAbort` stays on
      // the signal still holding the *shared* worker. A later abort of this
      // signal would then null the handlers of and terminate the worker that
      // whichever load owns it by then is decoding on, hanging that load
      // forever. Settle here like any other failure instead.
      //
      // The worker is deliberately not dropped: a throw here means the message
      // never left the main thread, so the worker never saw it and is still
      // idle and warm — and its laz-perf module staying warm across loads is
      // the whole reason it is long-lived. A worker that actually died fires
      // `onerror`, which drops it there.
      detach();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
    });
  } finally {
    releaseGate();
  }
}

/**
 * Decode a buffer to a FULL-RESOLUTION cloud through the shared parse worker.
 *
 * The converter keeps every point (unlike the viewer, which caps to a render
 * budget), so this posts a plan-less, unbounded-budget request — the same
 * worker `loadFile` uses, so the laz-perf WASM stays warm across a batch.
 * Routing here keeps the loader's synchronous work — the laz-perf
 * decompression loop for LAZ and the attribute-array expansion for every
 * format — off the calling thread, so a full-res re-decode or a batch
 * conversion no longer freezes the UI. Cancellable via `signal`.
 *
 * Throws `LoadError` for an unknown format and `LoadCancelledError` when the
 * signal aborts; other decode failures reject with the worker's error.
 */
export async function decodeFullViaWorker(
  buffer: ArrayBuffer,
  name: string,
  signal?: AbortSignal,
): Promise<PointCloud> {
  if (signal?.aborted) throw new LoadCancelledError();
  const format = sniffFormat(buffer, name);
  if (format === 'unknown') {
    throw new LoadError('unsupported-format', `Unrecognised file format: ${name}`);
  }

  // No worker can be constructed here (Node/SSR) and no fake was injected —
  // decode inline. The browser always has `Worker`, so production always routes
  // off-thread; this fallback only runs where a worker is genuinely unavailable.
  if (parseWorkerFactory === defaultParseWorkerFactory && typeof Worker === 'undefined') {
    const { cloud } = await parseBuffer(buffer, format, name, Number.MAX_SAFE_INTEGER);
    return cloud;
  }

  // Serialise with every other shared-worker user (see `workerGate`); release
  // in `finally` so a throw below can't wedge the queue.
  const releaseGate = await workerGate.acquire();
  try {
    if (signal?.aborted) throw new LoadCancelledError();
    return await new Promise<PointCloud>((resolve, reject) => {
      const worker = parseWorkerInstance();
      let settled = false;

      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        signal?.removeEventListener('abort', onAbort);
        // Terminate mid-decode — no orphan — and drop it so the next decode
        // lazily spawns a fresh worker.
        dropWorker(worker);
        reject(new LoadCancelledError());
      };
      const detach = (): void => {
        settled = true;
        worker.onmessage = null;
        worker.onerror = null;
        signal?.removeEventListener('abort', onAbort);
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort);

      worker.onmessage = (event: MessageEvent): void => {
        if (settled) return;
        const msg = event.data as WorkerReply;
        // A full-res decode surfaces no UI progress — drop the progress frames.
        if (msg.type === 'progress') return;
        detach();
        if (msg.type === 'error') {
          reject(
            msg.category ? new LoadError(msg.category, msg.error) : new Error(msg.error),
          );
          return;
        }
        resolve(new PointCloud(msg.cloud));
      };

      worker.onerror = (event: ErrorEvent): void => {
        if (settled) return;
        detach();
        dropWorker(worker);
        reject(new Error(event.message || 'Parse worker failed'));
      };

      // Full resolution: no plan, unbounded budget — every point is kept, and
      // the budget voxel-reduce is a no-op. The source buffer is transferred
      // (not copied) into the worker.
      try {
        worker.postMessage(
          { buffer, format, name, budget: Number.MAX_SAFE_INTEGER },
          [buffer],
        );
      } catch (err) {
        // Same guard as the load path: a synchronous post failure must run the
        // teardown, or the leaked `onAbort` outlives this decode still holding
        // the shared worker and terminates it under a later one.
        detach();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  } finally {
    releaseGate();
  }
}
