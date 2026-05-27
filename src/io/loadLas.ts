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
 *    parsed public header.
 *  - **`.laz`** (compressed): the `laz-perf` WASM decoder (a dependency of
 *    `@loaders.gl/las`, used here directly) decompresses each record. The
 *    decompressed record has the same int32 X/Y/Z prefix.
 *
 * ## Direct local-coordinate decode (v0.2.7)
 *
 * The render origin is computed from the header bounds *before* decoding, so
 * each record is converted straight into the local `Float32Array` the renderer
 * uses: `local = (int * scale + offset) - origin`. The whole right-hand side
 * is evaluated in float64 (JavaScript numbers are doubles) and only the final
 * store into the Float32Array narrows the small local residual — the same
 * precision contract the old `recenter` pass held, with no intermediate
 * float64 global array and no second pass. The round-trip `local + origin`
 * therefore reproduces the global coordinate to well within 1e-3 m (in
 * practice exactly, since the integers are exact).
 */

import { createLazPerf } from 'laz-perf';
// The laz-perf WASM is embedded as base64 and passed to the decoder as
// `wasmBinary`. This keeps the LAZ decoder fully self-contained — identical
// behaviour in the browser, a Web Worker, and Node, with no separate .wasm
// file to host and no network fetch. (The package default `main` is the Node
// build, which cannot locate its WASM in a browser bundle.)
import { LAZ_PERF_WASM_BASE64 } from './lazPerfWasm';
import { PointCloud } from '../model/PointCloud';
import type { CloudMetadata } from '../model/PointCloud';
import { parseLasHeader } from './lasHeader';
import type { LasHeader } from './lasHeader';
import { computeOrigin } from './coordinateBridge';
import { formatPointCount } from './loadPlan';
import type { ProgressUpdate } from './loadProgress';
import { makePrng, pickInBucket, STRIDE_SAMPLE_SEED } from './strideSample';

/** A `decoding` progress update for `done` of `total` points. */
function decodingUpdate(done: number, total: number): ProgressUpdate {
  return {
    stage: 'decoding',
    detail: `${formatPointCount(done)} of ${formatPointCount(total)} points`,
    fraction: total > 0 ? Math.min(1, done / total) : 1,
  };
}

// --- Point-record field offsets (shared by point formats 0-10) -------------
/** Intensity — uint16 LE, present in every point format at byte 12. */
const RECORD_INTENSITY = 12;
/**
 * Return-bits byte — present in every point format at byte 14. It packs the
 * return number and the number of returns; the bit split differs between the
 * legacy and extended record layouts (see {@link decodeRecord}).
 */
const RECORD_RETURN_BITS = 14;
/**
 * Classification byte offset. Point formats 0-5 store classification at
 * byte 15; the newer formats 6-10 store it at byte 16.
 */
const RECORD_CLASSIFICATION_LEGACY = 15;
const RECORD_CLASSIFICATION_EXT = 16;
/** Point source ID — uint16 LE — byte 18 in legacy records, byte 20 in extended. */
const RECORD_POINT_SOURCE_ID_LEGACY = 18;
const RECORD_POINT_SOURCE_ID_EXT = 20;
/** GPS time — float64 LE — byte 20 in legacy GPS records, byte 22 in extended. */
const RECORD_GPS_TIME_LEGACY = 20;
const RECORD_GPS_TIME_EXT = 22;
/** First point format index that uses the extended record layout. */
const FIRST_EXTENDED_FORMAT = 6;
/** Legacy point formats (0-5) that carry a GPS-time field. */
const LEGACY_GPS_FORMATS: readonly number[] = [1, 3, 4, 5];

/**
 * Mask isolating the classification value within the LAS classification byte.
 *
 * Point formats 0-5 pack the class into the **low 5 bits** of byte 15; bits
 * 5-7 are the synthetic / key-point / withheld flags. Formats 6-10 store
 * classification as a full byte (the flags moved to a separate field), so no
 * masking is needed. Reading the legacy byte unmasked would mistake a flagged
 * point's flags for part of its class — wrong colour in classification mode
 * and phantom classes in the Scan Report.
 */
export function classificationMaskFor(pointFormat: number): number {
  return pointFormat >= FIRST_EXTENDED_FORMAT ? 0xff : 0x1f;
}

/** Byte offset of the classification field for a given point format. */
function classificationOffsetFor(pointFormat: number): number {
  return pointFormat >= FIRST_EXTENDED_FORMAT
    ? RECORD_CLASSIFICATION_EXT
    : RECORD_CLASSIFICATION_LEGACY;
}

/**
 * Byte offset of the GPS-time field for a point format, or `null` when the
 * format carries none. A record length too short to hold the field (a
 * malformed header) also yields `null`, so the decode never reads past a
 * record.
 */
function gpsTimeOffsetFor(header: LasHeader): number | null {
  const extended = header.pointFormat >= FIRST_EXTENDED_FORMAT;
  if (!extended && !LEGACY_GPS_FORMATS.includes(header.pointFormat)) return null;
  const offset = extended ? RECORD_GPS_TIME_EXT : RECORD_GPS_TIME_LEGACY;
  return header.pointDataRecordLength >= offset + 8 ? offset : null;
}

/** Decoded local-coordinate positions plus per-point attributes. */
interface RawPoints {
  /** Interleaved local xyz, float32 — already recentred about the origin. */
  positions: Float32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  /** Return number (1-based) of the pulse this point belongs to. */
  returnNumber: Uint8Array;
  /** Total number of returns recorded for that pulse. */
  returnCount: Uint8Array;
  /** Point source ID — the flight line / source the point came from. */
  pointSourceId: Uint16Array;
  /** GPS time, or `null` when the point format carries no GPS-time field. */
  gpsTime: Float64Array | null;
}

/** Per-file constants reused across every record of one decode. */
interface DecodeContext {
  scale: [number, number, number];
  offset: [number, number, number];
  origin: [number, number, number];
  /** Byte offset of the classification field within a record. */
  classificationOffset: number;
  /** Mask applied to the classification byte. */
  classMask: number;
  /** True for the extended record layout (point formats 6-10). */
  extended: boolean;
  /** Byte offset of the point source ID within a record. */
  pointSourceIdOffset: number;
  /** Byte offset of the GPS-time field, or `null` when the format has none. */
  gpsTimeOffset: number | null;
}

/** Build the per-file decode context from a parsed header and its origin. */
function decodeContext(header: LasHeader, origin: [number, number, number]): DecodeContext {
  const extended = header.pointFormat >= FIRST_EXTENDED_FORMAT;
  return {
    scale: header.scale,
    offset: header.offset,
    origin,
    classificationOffset: classificationOffsetFor(header.pointFormat),
    classMask: classificationMaskFor(header.pointFormat),
    extended,
    pointSourceIdOffset: extended
      ? RECORD_POINT_SOURCE_ID_EXT
      : RECORD_POINT_SOURCE_ID_LEGACY,
    gpsTimeOffset: gpsTimeOffsetFor(header),
  };
}

/**
 * Decode one point record into the output arrays at point index `i`.
 *
 * `view` spans a buffer that holds the record; `base` is the record's byte
 * offset within it. Taking an offset rather than a per-record `DataView`
 * lets the caller reuse one `DataView` across millions of points.
 */
function decodeRecord(
  view: DataView,
  base: number,
  i: number,
  ctx: DecodeContext,
  out: RawPoints,
): void {
  const xi = view.getInt32(base, true);
  const yi = view.getInt32(base + 4, true);
  const zi = view.getInt32(base + 8, true);
  // local = (int * scale + offset) - origin, computed in float64; only the
  // store into the Float32Array narrows the small local residual.
  out.positions[i * 3 + 0] = xi * ctx.scale[0] + ctx.offset[0] - ctx.origin[0];
  out.positions[i * 3 + 1] = yi * ctx.scale[1] + ctx.offset[1] - ctx.origin[1];
  out.positions[i * 3 + 2] = zi * ctx.scale[2] + ctx.offset[2] - ctx.origin[2];
  out.intensity[i] = view.getUint16(base + RECORD_INTENSITY, true);
  out.classification[i] = view.getUint8(base + ctx.classificationOffset) & ctx.classMask;
  // Return bits: legacy formats pack return number into bits 0-2 and the
  // return count into bits 3-5; extended formats widen each to 4 bits.
  const returnBits = view.getUint8(base + RECORD_RETURN_BITS);
  if (ctx.extended) {
    out.returnNumber[i] = returnBits & 0x0f;
    out.returnCount[i] = (returnBits >> 4) & 0x0f;
  } else {
    out.returnNumber[i] = returnBits & 0x07;
    out.returnCount[i] = (returnBits >> 3) & 0x07;
  }
  out.pointSourceId[i] = view.getUint16(base + ctx.pointSourceIdOffset, true);
  if (ctx.gpsTimeOffset !== null && out.gpsTime !== null) {
    out.gpsTime[i] = view.getFloat64(base + ctx.gpsTimeOffset, true);
  }
}

/** Allocate the output arrays for `count` points. */
function allocRawPoints(count: number, hasGpsTime: boolean): RawPoints {
  return {
    positions: new Float32Array(count * 3),
    intensity: new Uint16Array(count),
    classification: new Uint8Array(count),
    returnNumber: new Uint8Array(count),
    returnCount: new Uint8Array(count),
    pointSourceId: new Uint16Array(count),
    gpsTime: hasGpsTime ? new Float64Array(count) : null,
  };
}

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
  const out = allocRawPoints(total, ctx.gpsTimeOffset !== null);
  // Report progress ~20 times across the decode — frequent enough to feel
  // live, sparse enough never to flood the worker's message channel.
  const reportEvery = Math.max(1, Math.floor(total / 20));
  // step 1: decode every record in order. step > 1: take one record per
  // bucket at a jittered offset, so the result does not band like a fixed
  // stride. One DataView over the whole file, no per-record allocation.
  const rand = step > 1 ? makePrng(STRIDE_SAMPLE_SEED) : undefined;
  for (let b = 0; b < total; b++) {
    const i = rand ? pickInBucket(b, step, count, rand) : b;
    decodeRecord(view, pointsOffset + i * recordLength, b, ctx, out);
    if (onProgress && (b + 1) % reportEvery === 0) onProgress(decodingUpdate(b + 1, total));
  }
  return out;
}

/** Decode the embedded base64 laz-perf WASM into bytes for `createLazPerf`. */
function lazPerfWasmBinary(): Uint8Array {
  const binary = atob(LAZ_PERF_WASM_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The instantiated laz-perf WASM module. */
type LazPerfModule = Awaited<ReturnType<typeof createLazPerf>>;

/**
 * Memoised laz-perf WASM module. Instantiating the decoder is the fixed cost
 * of a LAZ load; once this module instance has done it (e.g. inside the
 * persistent parse worker), every later `.laz` file reuses the same module —
 * only the per-file `LASZip` reader is created and freed each time. If
 * instantiation fails the memo is cleared so the next load can retry.
 */
let lazPerfModule: Promise<LazPerfModule> | undefined;

function getLazPerf(): Promise<LazPerfModule> {
  const existing = lazPerfModule;
  if (existing) return existing;
  const mod = createLazPerf({ wasmBinary: lazPerfWasmBinary() }).catch((err: unknown) => {
    lazPerfModule = undefined;
    throw err;
  });
  lazPerfModule = mod;
  return mod;
}

/**
 * Decode a compressed `.laz` file via the laz-perf WASM.
 *
 * Stride note: laz-perf decodes records strictly sequentially, so a
 * `stride > 1` cannot skip the decompression work — every record is still
 * decompressed. What stride saves on a `.laz` file is the coordinate transform
 * and the output storage: only one decompressed record per bucket is kept,
 * picked at a jittered offset so the result does not band along the scan lines.
 */
async function decodeLaz(
  buffer: ArrayBuffer,
  header: LasHeader,
  origin: [number, number, number],
  stride: number,
  onProgress?: (u: ProgressUpdate) => void,
): Promise<RawPoints> {
  const ctx = decodeContext(header, origin);
  // LAZ records are compressed and decoded sequentially, so the byte-length
  // clamp used for `.las` does not apply; the header count is trusted.
  const pointCount = header.pointCount;
  const step = Math.max(1, Math.floor(stride));
  const total = Math.ceil(pointCount / step);

  const lazPerf = await getLazPerf();
  const fileBytes = new Uint8Array(buffer);

  // Copy the compressed file into the WASM heap.
  const filePtr = lazPerf._malloc(fileBytes.byteLength);
  const reader = new lazPerf.LASZip();
  let pointPtr = 0;
  try {
    lazPerf.HEAPU8.set(fileBytes, filePtr);
    reader.open(filePtr, fileBytes.byteLength);

    const recordLength = reader.getPointLength();
    pointPtr = lazPerf._malloc(recordLength);

    const out = allocRawPoints(total, ctx.gpsTimeOffset !== null);
    const reportEvery = Math.max(1, Math.floor(pointCount / 20));

    // step 1: store every record. step > 1: store one record per bucket, at a
    // jittered offset. `chosen` is the record index wanted for the current
    // bucket; it is strictly increasing, so a single sequential sweep hits it.
    const rand = step > 1 ? makePrng(STRIDE_SAMPLE_SEED) : undefined;
    let bucket = 0;
    let chosen = rand ? pickInBucket(0, step, pointCount, rand) : 0;

    // A DataView over the WASM heap, reused across records. laz-perf can grow
    // its heap mid-stream, which detaches the old buffer — so the view is
    // refreshed only on the rare growth, never allocated per point.
    let heap = new DataView(lazPerf.HEAPU8.buffer);
    for (let i = 0; i < pointCount; i++) {
      // Every record must be decompressed (sequential decoder); only the
      // chosen record of each bucket is stored.
      reader.getPoint(pointPtr);
      if (heap.buffer !== lazPerf.HEAPU8.buffer) {
        heap = new DataView(lazPerf.HEAPU8.buffer);
      }
      if (i === chosen && bucket < total) {
        decodeRecord(heap, pointPtr, bucket, ctx, out);
        bucket++;
        if (bucket < total) {
          chosen = rand ? pickInBucket(bucket, step, pointCount, rand) : bucket;
        }
      }
      if (onProgress && i % reportEvery === 0) onProgress(decodingUpdate(bucket, total));
    }
    return out;
  } finally {
    reader.delete();
    if (pointPtr) lazPerf._free(pointPtr);
    lazPerf._free(filePtr);
  }
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
  const captureDate = formatCreationDate(header.creationYear, header.creationDay);
  if (captureDate) metadata.captureDate = captureDate;
  // v0.3.2-Georef — surface the CRS parsed from LASF_Projection VLRs so the
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
 *                     Used by the v0.2.7 fast-load path for huge clouds.
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

  const raw =
    sourceFormat === 'laz'
      ? await decodeLaz(buffer, header, origin, stride, onProgress)
      : decodeLas(buffer, header, origin, stride, onProgress);

  const decodedPointCount = raw.positions.length / 3;

  return new PointCloud({
    positions: raw.positions,
    intensity: raw.intensity,
    classification: raw.classification,
    returnNumber: raw.returnNumber,
    returnCount: raw.returnCount,
    pointSourceId: raw.pointSourceId,
    gpsTime: raw.gpsTime ?? undefined,
    origin,
    sourceFormat,
    name,
    declaredPointCount: header.pointCount,
    decodedPointCount,
    metadata: lasMetadata(header),
  });
}
