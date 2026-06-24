/**
 * lasDecodeShared.ts
 *
 * Decode primitives shared between the static `.las` reader (in `loadLas.ts`)
 * and the LAZ decompressor (in `lazDecode.ts`). Both readers ultimately
 * decode LAS point records — the difference is only how they get the
 * compressed/uncompressed bytes into memory.
 *
 * Extracting these primitives lets `loadLas.ts` stay tiny (uncompressed-only)
 * and `lazDecode.ts` live in a lazy chunk that pulls in laz-perf + WASM only
 * when a `.laz` file is actually opened.
 */

import type { LasHeader } from './lasHeader';
import { formatPointCount } from './loadPlan';
import type { ProgressUpdate } from './loadProgress';

// --- Point-record field offsets (shared by point formats 0-10) -------------
/** Intensity — uint16 LE, present in every point format at byte 12. */
const RECORD_INTENSITY = 12;
/**
 * Return-bits byte — present in every point format at byte 14. It packs the
 * return number and the number of returns; the bit split differs between the
 * legacy and extended record layouts (see {@link decodeRecord}).
 */
const RECORD_RETURN_BITS = 14;
/** Classification byte offset for legacy / extended point formats. */
const RECORD_CLASSIFICATION_LEGACY = 15;
const RECORD_CLASSIFICATION_EXT = 16;
/** Point source ID — uint16 LE — byte 18 in legacy records, byte 20 in extended. */
const RECORD_POINT_SOURCE_ID_LEGACY = 18;
const RECORD_POINT_SOURCE_ID_EXT = 20;
/** GPS time — float64 LE — byte 20 in legacy GPS records, byte 22 in extended. */
const RECORD_GPS_TIME_LEGACY = 20;
const RECORD_GPS_TIME_EXT = 22;
/** First point format index that uses the extended record layout. */
export const FIRST_EXTENDED_FORMAT = 6;
/** Legacy point formats (0-5) that carry a GPS-time field. */
const LEGACY_GPS_FORMATS: readonly number[] = [1, 3, 4, 5];

/**
 * Mask isolating the classification value within the LAS classification byte.
 * Re-exported via loadLas.ts for external consumers (analysis modules).
 */
export function classificationMaskFor(pointFormat: number): number {
  return pointFormat >= FIRST_EXTENDED_FORMAT ? 0xff : 0x1f;
}

function classificationOffsetFor(pointFormat: number): number {
  return pointFormat >= FIRST_EXTENDED_FORMAT
    ? RECORD_CLASSIFICATION_EXT
    : RECORD_CLASSIFICATION_LEGACY;
}

function gpsTimeOffsetFor(header: LasHeader): number | null {
  const extended = header.pointFormat >= FIRST_EXTENDED_FORMAT;
  if (!extended && !LEGACY_GPS_FORMATS.includes(header.pointFormat)) return null;
  const offset = extended ? RECORD_GPS_TIME_EXT : RECORD_GPS_TIME_LEGACY;
  return header.pointDataRecordLength >= offset + 8 ? offset : null;
}

/**
 * Byte offset of the RGB triple within a point record, or null for formats
 * that carry no colour. RGB is three uint16s. Offsets:
 *   format 2            → 20 (no GPS, colour right after the core)
 *   formats 3, 5        → 28 (after the 8-byte GPS field)
 *   formats 7, 8, 10    → 30 (after the 30-byte extended core)
 * Honoured only when the record is actually long enough to hold the triple.
 */
function rgbOffsetFor(header: LasHeader): number | null {
  let offset: number;
  switch (header.pointFormat) {
    case 2: offset = 20; break;
    case 3: case 5: offset = 28; break;
    case 7: case 8: case 10: offset = 30; break;
    default: return null;
  }
  return header.pointDataRecordLength >= offset + 6 ? offset : null;
}

/** Decoded local-coordinate positions plus per-point attributes. */
export interface RawPoints {
  positions: Float32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  returnNumber: Uint8Array;
  returnCount: Uint8Array;
  pointSourceId: Uint16Array;
  gpsTime: Float64Array | null;
  /** Interleaved rgb (0–255), or null when the point format carries no colour.
   *  Filled by {@link finalizeRawColors} after decode — null until then. */
  colors: Uint8Array | null;
  /** Raw interleaved 16-bit rgb staging buffer the decode loop writes into, so
   *  the 8-bit-vs-16-bit narrowing decision is made ONCE per file (not per
   *  record). Cleared by {@link finalizeRawColors}. Null when no colour. */
  colors16: Uint16Array | null;
}

/** Per-file constants reused across every record of one decode. */
export interface DecodeContext {
  scale: [number, number, number];
  offset: [number, number, number];
  origin: [number, number, number];
  classificationOffset: number;
  classMask: number;
  extended: boolean;
  pointSourceIdOffset: number;
  gpsTimeOffset: number | null;
  rgbOffset: number | null;
}

export function decodeContext(
  header: LasHeader,
  origin: [number, number, number],
): DecodeContext {
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
    rgbOffset: rgbOffsetFor(header),
  };
}

/**
 * Decode one point record into the output arrays at point index `i`.
 *
 * `view` spans a buffer that holds the record; `base` is the record's byte
 * offset within it. Taking an offset rather than a per-record `DataView`
 * lets the caller reuse one `DataView` across millions of points.
 */
export function decodeRecord(
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
  if (ctx.rgbOffset !== null && out.colors16 !== null) {
    const o = base + ctx.rgbOffset;
    // Stage the raw 16-bit channels; finalizeRawColors decides 8-bit vs 16-bit
    // narrowing once per file. Files this app writes use ×257 (value << 8); some
    // third-party files store 8-bit values in the low byte — both round-trip
    // correctly through the file-level scan in finalizeRawColors.
    out.colors16[i * 3 + 0] = view.getUint16(o, true);
    out.colors16[i * 3 + 1] = view.getUint16(o + 2, true);
    out.colors16[i * 3 + 2] = view.getUint16(o + 4, true);
  }
}

export function allocRawPoints(
  count: number,
  hasGpsTime: boolean,
  hasColor = false,
): RawPoints {
  return {
    positions: new Float32Array(count * 3),
    intensity: new Uint16Array(count),
    classification: new Uint8Array(count),
    returnNumber: new Uint8Array(count),
    returnCount: new Uint8Array(count),
    pointSourceId: new Uint16Array(count),
    gpsTime: hasGpsTime ? new Float64Array(count) : null,
    // Colour is staged as raw 16-bit and narrowed once in finalizeRawColors;
    // `colors` (the 8-bit render buffer) is allocated there.
    colors: null,
    colors16: hasColor ? new Uint16Array(count * 3) : null,
  };
}

/**
 * Narrow the staged 16-bit RGB into the renderer's 8-bit `colors` buffer with a
 * SINGLE per-file bit-depth decision, then release the staging buffer. Some
 * writers store 8-bit values directly in the low byte of the 16-bit field
 * (values 0–255); narrowing those with `>> 8` would yield 0 and render the
 * whole cloud black. So we scan the file's max channel value: ≤ 255 ⇒ the file
 * is 8-bit-in-low-byte (copy verbatim), else it is full-range 16-bit (high
 * byte). This mirrors the COPC decoder's per-chunk detection, lifted to the
 * file level so it is deterministic across the whole cloud.
 */
export function finalizeRawColors(raw: RawPoints): void {
  const src = raw.colors16;
  if (!src) return;
  let maxRgb = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] > maxRgb) maxRgb = src[i];
  }
  const eightBit = maxRgb <= 255;
  const out = new Uint8Array(src.length);
  if (eightBit) {
    out.set(src); // values already 0–255
  } else {
    for (let i = 0; i < src.length; i++) out[i] = src[i] >> 8;
  }
  raw.colors = out;
  raw.colors16 = null;
}

export function decodingUpdate(done: number, total: number): ProgressUpdate {
  return {
    stage: 'decoding',
    detail: `${formatPointCount(done)} of ${formatPointCount(total)} points`,
    fraction: total > 0 ? Math.min(1, done / total) : 1,
  };
}
