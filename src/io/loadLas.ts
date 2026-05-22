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
 * the raw integer point records and converts them in float64:
 *
 *  - **`.las`** (uncompressed): the point records are read straight from the
 *    file. Every LAS point record — for every point format — begins with
 *    int32 X, Y, Z. We honour `offsetToPointData` and `pointDataRecordLength`
 *    from the header.
 *  - **`.laz`** (compressed): the `laz-perf` WASM decoder (a dependency of
 *    `@loaders.gl/las`, used here directly) decompresses each record. The
 *    decompressed record has the same int32 X/Y/Z prefix.
 *
 * In both cases `global = int * scale + offset` is computed in float64 and the
 * result is handed to `recenter()`, whose own contract keeps the subtraction
 * in float64 and only narrows to float32 for the small local residual. The
 * round-trip `local + origin` therefore reproduces the global coordinate to
 * well within 1e-3 m (in practice exactly, since the integers are exact).
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
import { computeOrigin, recenter } from './coordinateBridge';

// --- LAS public-header byte offsets we need beyond `parseLasHeader` --------
/** Offset to the first point record — uint32 LE. */
const OFFSET_TO_POINT_DATA = 96;
/** Point data record length in bytes — uint16 LE. */
const OFFSET_POINT_RECORD_LENGTH = 105;

// --- Point-record field offsets (shared by point formats 0-10) -------------
/** Intensity — uint16 LE, present in every point format at byte 12. */
const RECORD_INTENSITY = 12;
/**
 * Classification byte offset. Point formats 0-5 store classification at
 * byte 15; the newer formats 6-10 store it at byte 16.
 */
const RECORD_CLASSIFICATION_LEGACY = 15;
const RECORD_CLASSIFICATION_EXT = 16;
/** First point format index that uses the extended record layout. */
const FIRST_EXTENDED_FORMAT = 6;

/** Raw, scale-applied global coordinates plus per-point attributes. */
interface RawPoints {
  /** Interleaved global xyz, float64 — exact within integer*scale. */
  global: Float64Array;
  intensity: Uint16Array;
  classification: Uint8Array;
}

/** Read the point format id from the LAS public header (uint8 at byte 104). */
function readPointFormat(buffer: ArrayBuffer): number {
  // LAZ sets the high bit (0x80) to flag compression; mask it off.
  return new DataView(buffer).getUint8(104) & 0x3f;
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
  scale: [number, number, number],
  offset: [number, number, number],
  classificationOffset: number,
  out: RawPoints,
): void {
  const xi = view.getInt32(base, true);
  const yi = view.getInt32(base + 4, true);
  const zi = view.getInt32(base + 8, true);
  // int * scale + offset, all in float64.
  out.global[i * 3 + 0] = xi * scale[0] + offset[0];
  out.global[i * 3 + 1] = yi * scale[1] + offset[1];
  out.global[i * 3 + 2] = zi * scale[2] + offset[2];
  out.intensity[i] = view.getUint16(base + RECORD_INTENSITY, true);
  out.classification[i] = view.getUint8(base + classificationOffset);
}

/** Decode every record of an uncompressed `.las` file. */
function decodeLas(buffer: ArrayBuffer, pointCount: number): RawPoints {
  const header = parseLasHeader(buffer);
  const view = new DataView(buffer);
  const pointsOffset = view.getUint32(OFFSET_TO_POINT_DATA, true);
  const recordLength = view.getUint16(OFFSET_POINT_RECORD_LENGTH, true);
  const format = readPointFormat(buffer);
  const classificationOffset =
    format >= FIRST_EXTENDED_FORMAT ? RECORD_CLASSIFICATION_EXT : RECORD_CLASSIFICATION_LEGACY;

  const out: RawPoints = {
    global: new Float64Array(pointCount * 3),
    intensity: new Uint16Array(pointCount),
    classification: new Uint8Array(pointCount),
  };

  // One DataView over the whole file, indexed by an absolute byte offset —
  // no per-record allocation in this multi-million-iteration loop.
  for (let i = 0; i < pointCount; i++) {
    const base = pointsOffset + i * recordLength;
    decodeRecord(view, base, i, header.scale, header.offset, classificationOffset, out);
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

/** Decode every record of a compressed `.laz` file via the laz-perf WASM. */
async function decodeLaz(buffer: ArrayBuffer, pointCount: number): Promise<RawPoints> {
  const header = parseLasHeader(buffer);
  const format = readPointFormat(buffer);
  const classificationOffset =
    format >= FIRST_EXTENDED_FORMAT ? RECORD_CLASSIFICATION_EXT : RECORD_CLASSIFICATION_LEGACY;

  const lazPerf = await createLazPerf({ wasmBinary: lazPerfWasmBinary() });
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

    const out: RawPoints = {
      global: new Float64Array(pointCount * 3),
      intensity: new Uint16Array(pointCount),
      classification: new Uint8Array(pointCount),
    };

    // A DataView over the WASM heap, reused across records. laz-perf can grow
    // its heap mid-stream, which detaches the old buffer — so the view is
    // refreshed only on the rare growth, never allocated per point.
    let heap = new DataView(lazPerf.HEAPU8.buffer);
    for (let i = 0; i < pointCount; i++) {
      // Decompress record `i` into the scratch buffer, then read it.
      reader.getPoint(pointPtr);
      if (heap.buffer !== lazPerf.HEAPU8.buffer) {
        heap = new DataView(lazPerf.HEAPU8.buffer);
      }
      decodeRecord(heap, pointPtr, i, header.scale, header.offset, classificationOffset, out);
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
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Load a `.las` or `.laz` point cloud into a `PointCloud`.
 *
 * Positions are recentered about a floored-min `origin`; `intensity` and
 * `classification` are decoded straight from the (raw) point records.
 *
 * @param buffer       Raw file bytes.
 * @param sourceFormat Either `'las'` or `'laz'`.
 * @param name         Display name (defaults to `"cloud.<format>"`).
 */
export async function loadLas(
  buffer: ArrayBuffer,
  sourceFormat: 'las' | 'laz',
  name = `cloud.${sourceFormat}`,
): Promise<PointCloud> {
  const header = parseLasHeader(buffer);
  const pointCount = header.pointCount;

  const raw =
    sourceFormat === 'laz'
      ? await decodeLaz(buffer, pointCount)
      : decodeLas(buffer, pointCount);

  // Origin from the floored header min; recenter in float64 -> float32.
  const origin = computeOrigin(header.min);
  const positions = recenter(raw.global, origin);

  return new PointCloud({
    positions,
    intensity: raw.intensity,
    classification: raw.classification,
    origin,
    sourceFormat,
    name,
    declaredPointCount: header.pointCount,
    decodedPointCount: pointCount,
    metadata: lasMetadata(header),
  });
}
