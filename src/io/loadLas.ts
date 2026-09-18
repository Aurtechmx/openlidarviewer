/**
 * LAS / LAZ loader with full coordinate precision.
 *
 * ## Why this loader decodes point records by hand
 *
 * `@loaders.gl/las` returns vertex positions as **float32 global** UTM
 * coordinates. A float32 has only ~24 bits of mantissa, so a value such as
 * 4_100_876.789 snaps to roughly a 0.5 m grid — sub-metre detail is gone
 * before we can recenter it. On top of that, the bundled laz-perf build in
 * `@loaders.gl/las` rejects LAS 1.4 outright ("Only file versions <= 1.3 are
 * supported"), and its laz-rs loader fetches a WASM bundle from the network.
 *
 * To get reliable, offline, full-precision results this loader instead reads
 * the raw integer point records and converts them itself:
 *
 *  - **`.las`** (uncompressed): the point records are read straight from the
 *    file. Every LAS point record — for every point format — begins with
 *    int32 X, Y, Z. The point-data offset and record length come from the
 *    parsed public header. This path stays entirely inside this module.
 *  - **`.laz`** (compressed): the `laz-perf` WASM decoder is loaded LAZILY
 *    via `import('./lazDecode')` so that uncompressed `.las` files never pay
 *    the 290 KB WASM blob download cost. The decompressed record has the
 *    same int32 X/Y/Z prefix; the shared primitives in `lasDecodeShared.ts`
 *    do the actual record decode for both paths.
 *
 * ## Direct local-coordinate decode
 *
 * The render origin is computed from the header bounds *before* decoding, so
 * each record is converted straight into the local `Float32Array` the renderer
 * uses: `local = (int * scale + offset) - origin`. The whole right-hand side
 * is evaluated in float64 (JavaScript numbers are doubles) and only the final
 * store into the Float32Array narrows the small local residual.
 */

import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { parseLasHeader } from './lasHeader';
import type { LasHeader } from './lasHeader';
import { computeOrigin } from './coordinateBridge';
import { sanitizeLocalCloud, withLoadWarning } from './sanitizeCloud';
import { makePrng, pickInBucket, STRIDE_SAMPLE_SEED } from './strideSample';
import type { ProgressUpdate } from './loadProgress';
import type { RangeSource } from './range/RangeSource';
import type { DecodePoolPolicy } from './heavy/worker/lazChunkWorkerClient';
import {
  allocRawPoints,
  decodeContext,
  decodeRecord,
  decodingUpdate,
  finalizeRawColors,
  type RawPoints,
} from './lasDecodeShared';

// Re-export so external callers (analysis modules) keep their existing import path.
export { classificationMaskFor } from './lasDecodeShared';

/**
 * Decode an uncompressed `.las` file. With `stride > 1` the records are split
 * into buckets of `stride` and one record is read from each at a jittered
 * offset (see `strideSample.ts`) — `.las` records are fixed-length and
 * randomly addressable, so the rest are skipped entirely (a genuine
 * decode-time saving for clouds far over budget). The jitter is what keeps
 * the fast-load result from banding along the scan lines.
 */
function decodeLas(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  stride: number,
  onProgress?: (u: ProgressUpdate) => void,
): RawPoints {
  const view = new DataView(buffer);
  const pointsOffset = header.offsetToPointData;
  const recordLength = header.pointDataRecordLength;
  const ctx = decodeContext(header, origin);

  // Clamp the count to what the file can actually hold. A header that claims
  // more points than the file contains would otherwise read past the buffer
  // and throw an opaque RangeError partway through the decode.
  const available =
    recordLength > 0 ? Math.floor((buffer.byteLength - pointsOffset) / recordLength) : 0;
  const count = Math.min(header.pointCount, Math.max(0, available));

  const step = Math.max(1, Math.floor(stride));
  const total = Math.ceil(count / step);
  const out = allocRawPoints(total, ctx.gpsTimeOffset !== null, ctx.rgbOffset !== null);
  const reportEvery = Math.max(1, Math.floor(total / 20));
  const rand = step > 1 ? makePrng(STRIDE_SAMPLE_SEED) : undefined;
  for (let b = 0; b < total; b++) {
    const i = rand ? pickInBucket(b, step, count, rand) : b;
    decodeRecord(view, pointsOffset + i * recordLength, b, ctx, out);
    if (onProgress && (b + 1) % reportEvery === 0) onProgress(decodingUpdate(b + 1, total));
  }
  finalizeRawColors(out); // narrow staged 16-bit RGB once, per-file
  return out;
}

/**
 * Re-export `getLazPerf` for the EPT laszip tile decoder. The dynamic
 * import here means the EPT path also pulls the lazy WASM chunk — exactly
 * the same chunk the `.laz` open path uses, so the single-instantiation
 * memo inside `lazDecode.ts` is shared across both call sites.
 *
 * Existing call shape preserved: `import { getLazPerf } from '../loadLas'`.
 */
export async function getLazPerf(): Promise<
  Awaited<ReturnType<typeof import('./lazDecode').getLazPerf>>
> {
  const mod = await import('./lazDecode');
  return mod.getLazPerf();
}

/**
 * Format a LAS header creation date. The header stores a day-of-year and a
 * year; a plausible year is required, and a valid day refines it to a date.
 */
function formatCreationDate(year: number, day: number): string | undefined {
  if (year < 1990 || year > 2100) return undefined;
  if (day < 1 || day > 366) return String(year);
  const date = new Date(Date.UTC(year, 0, day));
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Build provenance metadata from a LAS header — the capture sensor, the
 * software that wrote the file, and the creation date — keeping only the
 * fields the header actually filled in.
 */
function lasMetadata(header: LasHeader): CloudMetadata | undefined {
  const metadata: CloudMetadata = {};
  if (header.systemIdentifier) metadata.captureSensor = header.systemIdentifier;
  if (header.generatingSoftware) metadata.sourceSoftware = header.generatingSoftware;
  metadata.pointFormat = header.pointFormat;
  const captureDate = formatCreationDate(header.creationYear, header.creationDay);
  if (captureDate) metadata.captureDate = captureDate;
  // surface the CRS parsed from LASF_Projection VLRs so the
  // Scan Intelligence panel + scan-report card + measurement tool can show
  // the source datum and convert measurements from feet to metres when the
  // CRS declares a non-metric linear unit.
  if (header.crs) metadata.crs = header.crs;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Load a `.las` or `.laz` point cloud into a `PointCloud`.
 *
 * Positions are decoded directly into local space about a floored-min
 * `origin`; `intensity` and `classification` are decoded straight from the
 * (raw) point records. The header is parsed once and threaded into the
 * decoder.
 *
 * @param buffer       Raw file bytes.
 * @param sourceFormat Either `'las'` or `'laz'`.
 * @param name         Display name (defaults to `"cloud.<format>"`).
 * @param stride       Decode every `stride`-th record (1 = every record).
 *                     Used by the fast-load path for huge clouds.
 * @param onProgress   Optional staged-progress callback for the decode loop.
 */
export async function loadLas(
  buffer: ArrayBuffer,
  sourceFormat: 'las' | 'laz',
  name = `cloud.${sourceFormat}`,
  stride = 1,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<PointCloud> {
  const header = parseLasHeader(buffer);
  // Origin from the floored header min — known before decoding, so records
  // are converted straight into local coordinates.
  const origin = computeOrigin(header.min);
  const toCloud = (raw: RawPoints): PointCloud =>
    cloudFromRaw(raw, header, origin, sourceFormat, name, stride);

  let raw: RawPoints;
  if (sourceFormat === 'laz') {
    // Lazy chunk: pulls laz-perf + the embedded WASM only when a `.laz`
    // file is actually opened. Uncompressed `.las` files never download it.
    const { decodeLaz } = await import('./lazDecode');
    // The file's chunks can be fanned across a worker pool — byte-for-byte the
    // same points, produced in parallel. This holds at any stride: laz-perf
    // cannot skip records either way, so the pooled path decompresses exactly
    // what `decodeLaz` does and keeps the same stratified sample, only spread
    // over cores. It fails closed — `decodeLazPooled` returns null (engaging no
    // worker) for a small unflagged file, for a session that refused pooling,
    // and for any file its chunk table cannot describe — so `decodeLaz` stays
    // the fallback for all three.
    const pooled = await (
      await import('./heavy/worker/lazChunkWorkerClient')
    ).decodeLazPooled(buffer, header, origin, { stride, onProgress });
    raw = pooled ?? (await decodeLaz(buffer, header, origin, stride, onProgress));
  } else {
    raw = decodeLas(buffer, header, origin, stride, onProgress);
  }
  return toCloud(raw);
}

/** Prefix read for the header peek; the public header is 375 bytes at most. */
const LAZ_HEAD_PEEK_BYTES = 64 * 1024;
/** Where the LAS public header records the offset to point data. */
const OFFSET_TO_POINT_DATA = 96;

/**
 * Load a `.laz` straight from its `File`, reading what each step needs.
 *
 * The header comes from a prefix read. When the pool engages, each chunk's
 * bytes are read as that chunk is decoded, so the compressed file is never
 * resident whole; when it does not (a small file, a session that refused
 * pooling, a file with no usable chunk table) the file is read whole here, in
 * the worker, and decoded as before. Same records, same order, same sample
 * as {@link loadLas} on the file's bytes.
 */
export async function loadLazFromFile(
  file: File,
  name = 'cloud.laz',
  stride = 1,
  onProgress?: (u: ProgressUpdate) => void,
  onPreviewChunk?: PreviewChunkSink,
  onStats?: (stats: LazLoadStats) => void,
  policy?: DecodePoolPolicy,
  previewBudget?: number,
): Promise<PointCloud> {
  let head = await file.slice(0, LAZ_HEAD_PEEK_BYTES).arrayBuffer();
  // The VLRs sit between the public header and the point data; a file whose
  // VLR block outgrows the peek is re-read up to where the points start.
  if (head.byteLength >= OFFSET_TO_POINT_DATA + 4) {
    const toPoints = new DataView(head).getUint32(OFFSET_TO_POINT_DATA, true);
    if (toPoints > head.byteLength && toPoints <= file.size) {
      head = await file.slice(0, toPoints).arrayBuffer();
    }
  }
  const header = parseLasHeader(head);
  const origin = computeOrigin(header.min);
  const toCloud = (raw: RawPoints): PointCloud =>
    cloudFromRaw(raw, header, origin, 'laz', name, stride);

  const { decodeLazPooledFromSource } = await import('./heavy/worker/lazChunkWorkerClient');
  const { LocalFileRangeSource } = await import('./range/LocalFileRangeSource');
  const { createRangeLedger } = await import('./range/rangeLedger');
  // Every ranged read is counted so the load can say what it read and when.
  const inner = new LocalFileRangeSource(file);
  // The header prefix was read off the `File` directly, so it is recorded here
  // for the ledger to see: a later read of the same offsets is a re-read, and
  // the totals say so rather than hiding it.
  const ledger = createRangeLedger();
  ledger.record(0, head.byteLength);
  const stats = {
    fileName: file.name,
    fileBytes: file.size,
    declaredPointCount: header.pointCount,
    pointFormat: header.pointFormat,
    lazChunkCount: undefined as number | undefined,
    decodeStride: stride,
    previewBudget,
    metadataBytes: head.byteLength,
    rangeRequests: 1,
    requestedBytes: head.byteLength,
    uniqueBytesRead: head.byteLength,
    rereadBytes: 0,
    compressedBytesBeforePreview: undefined as number | undefined,
    compressedBytesRead: 0,
    poolWorkers: undefined as number | undefined,
    decodePath: 'whole-file' as LazLoadStats['decodePath'],
    poolFallbackReason: undefined as string | undefined,
  };
  const settleLedger = (): void => {
    const totals = ledger.totals();
    stats.rangeRequests = totals.requests;
    stats.requestedBytes = totals.requestedBytes;
    stats.uniqueBytesRead = totals.uniqueBytes;
    stats.rereadBytes = totals.requestedBytes - totals.uniqueBytes;
  };
  let planned = false;
  const counted: RangeSource = {
    id: () => inner.id(),
    kind: () => inner.kind(),
    size: () => inner.size(),
    readRange: async (offset, length, signal) => {
      const bytes = await inner.readRange(offset, length, signal);
      // The ledger holds the requested span; the byte counters hold what came
      // back, which is shorter when a read ran past the end of the file.
      ledger.record(offset, length);
      if (planned) stats.compressedBytesRead += bytes.byteLength;
      else stats.metadataBytes += bytes.byteLength;
      return bytes;
    },
  };
  const frame = previewFrame(header, origin);
  let expectedPoints = header.pointCount;
  const pooled = await decodeLazPooledFromSource(counted, header, origin, {
    stride,
    onProgress,
    previewBudget,
    onPreviewChunk: onPreviewChunk && ((positions, outIndex) => {
      // What the file cost up to the first sample the page can draw.
      stats.compressedBytesBeforePreview ??= stats.compressedBytesRead;
      // Transport only: the sample's own buffer, in the frame the decoder wrote it.
      onPreviewChunk({ positions, outIndex, expectedPoints, frame });
    }),
    onPlanned: (info) => {
      planned = true;
      expectedPoints = info.expectedPoints;
      stats.lazChunkCount = info.chunkCount;
    },
    onPool: ({ workers }) => { stats.poolWorkers = workers; stats.decodePath = 'pooled'; },
    onFallback: (reason) => { stats.poolFallbackReason = reason; stats.decodePath = 'pool-fallback'; },
    onSkipped: (reason) => { stats.poolFallbackReason = reason; },
    policy,
  });
  if (pooled) {
    settleLedger();
    onStats?.(stats);
    return toCloud(pooled);
  }

  const { decodeLaz } = await import('./lazDecode');
  const buffer = await file.arrayBuffer();
  // The whole-file read covers the file once more, prefix included.
  ledger.record(0, buffer.byteLength);
  stats.compressedBytesRead += buffer.byteLength;
  settleLedger();
  onStats?.(stats);
  return toCloud(await decodeLaz(buffer, header, origin, stride, onProgress));
}

/** Which file a LAZ load read, what it read of it, and which decoder produced it. */
export interface LazLoadStats {
  /** The file's own name, so a measured row says what it was measured on. */
  readonly fileName: string;
  readonly fileBytes: number;
  readonly declaredPointCount: number;
  /** Point data record format id (PDRF) from the header. */
  readonly pointFormat: number;
  /** Chunks the chunk table described, absent when no chunked plan was made. */
  readonly lazChunkCount?: number;
  readonly decodeStride: number;
  readonly previewBudget?: number;
  readonly metadataBytes: number;
  readonly rangeRequests: number;
  /** Requested read lengths summed, re-reads counted each time. */
  readonly requestedBytes: number;
  /** Bytes of the file the requested spans cover, each counted once. */
  readonly uniqueBytesRead: number;
  /** `requestedBytes` minus `uniqueBytesRead`. */
  readonly rereadBytes: number;
  /** Compressed bytes counted when the first preview chunk was handed on. */
  readonly compressedBytesBeforePreview?: number;
  readonly compressedBytesRead: number;
  readonly poolWorkers?: number;
  readonly decodePath: 'pooled' | 'whole-file' | 'pool-fallback';
  readonly poolFallbackReason?: string;
}

/** The preview's frame: the header's declared extent, in the cloud's local frame. */
export type PreviewFrame = { readonly min: [number, number, number]; readonly max: [number, number, number] };

/**
 * One chunk's share of the decode's preview sample, for a preview that fills in
 * as the decode runs, with what the receiver needs to size and frame it: the
 * records the finished decode will hold, and the header's declared extent when
 * usable. The decoder has already thinned these positions to the page's preview
 * budget, so the receiver stores them as they arrive rather than sampling again.
 */
export interface PreviewChunk {
  readonly positions: Float32Array;
  /**
   * Where this chunk's first record lands in the decode's output. The positions
   * are already the chunk's share of one whole-file sample, so a receiver may
   * append them in arrival order; the index says which part of the cloud they
   * came from.
   */
  readonly outIndex: number;
  readonly expectedPoints: number;
  readonly frame?: PreviewFrame;
}

/** Receives each preview chunk as it is placed. */
export type PreviewChunkSink = (chunk: PreviewChunk) => void;

/**
 * The header's declared bounds shifted into the render-local frame, or
 * undefined when they cannot frame a view: a non-finite value, a min above
 * its max, or an extent that is flat on more than one axis. Declared bounds
 * frame the camera; they do not claim where points are inside them.
 */
export function previewFrame(header: LasHeader, origin: [number, number, number]): PreviewFrame | undefined {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  let flat = 0;
  for (let a = 0; a < 3; a++) {
    const lo = header.min[a] - origin[a];
    const hi = header.max[a] - origin[a];
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return undefined;
    if (hi - lo <= 0) flat++;
    min[a] = lo;
    max[a] = hi;
  }
  return flat > 1 ? undefined : { min, max };
}

/** Sanitise decoded records and wrap them as a cloud with the header's facts. */
function cloudFromRaw(
  raw: RawPoints,
  header: LasHeader,
  origin: [number, number, number],
  sourceFormat: 'las' | 'laz',
  name: string,
  stride: number,
): PointCloud {
  const decodedPointCount = raw.positions.length / 3;

  // A LAS coordinate is `int * scale + offset`, and the header guard already
  // refuses a non-finite scale or offset — but a finite, astronomically large
  // scale still multiplies a big record out past the double range to ±Infinity.
  // Records are decoded straight into local space about the header's origin, so
  // there is no origin here to protect: only the points and their attributes.
  // `decodedPointCount` stays what the decoder read, which is what the Health
  // Check compares against the header; the warning reports the exclusion.
  const clean = sanitizeLocalCloud(raw.positions, {
    colors: raw.colors ?? undefined,
    intensity: raw.intensity,
    classification: raw.classification,
    classificationFlags: raw.classificationFlags,
    returnNumber: raw.returnNumber,
    returnCount: raw.returnCount,
    pointSourceId: raw.pointSourceId,
    gpsTime: raw.gpsTime ?? undefined,
  });

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    intensity: clean.attributes.intensity,
    classification: clean.attributes.classification,
    classificationFlags: clean.attributes.classificationFlags,
    returnNumber: clean.attributes.returnNumber,
    returnCount: clean.attributes.returnCount,
    pointSourceId: clean.attributes.pointSourceId,
    gpsTime: clean.attributes.gpsTime,
    origin,
    sourceFormat,
    name,
    declaredPointCount: header.pointCount,
    decodedPointCount,
    // Record the DELIBERATE decode stride (the display-sample cap) so the
    // Health Check can tell a capped load from genuine decode loss.
    loadStride: Math.max(1, Math.floor(stride)),
    metadata: withLoadWarning(lasMetadata(header), clean.warning),
  });
}
