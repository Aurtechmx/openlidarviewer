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

/** Decoded local-coordinate positions plus per-point attributes. */
export interface RawPoints {
  positions: Float32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  returnNumber: Uint8Array;
  returnCount: Uint8Array;
  pointSourceId: Uint16Array;
  gpsTime: Float64Array | null;
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
}

export function allocRawPoints(count: number, hasGpsTime: boolean): RawPoints {
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

export function decodingUpdate(done: number, total: number): ProgressUpdate {
  return {
    stage: 'decoding',
    detail: `${formatPointCount(done)} of ${formatPointCount(total)} points`,
    fraction: total > 0 ? Math.min(1, done / total) : 1,
  };
}
