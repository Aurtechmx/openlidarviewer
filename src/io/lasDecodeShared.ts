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
export const RECORD_CLASSIFICATION_LEGACY = 15;
export const RECORD_CLASSIFICATION_EXT = 16;
/**
 * Byte offset of the classification-flags source byte. Coincidentally 15 in
 * both layouts: extended keeps a dedicated flags byte there, legacy packs the
 * flags into bits 5-7 of the classification byte, which also sits at 15. Any
 * decoder reading raw LAS/LAZ-family records (COPC, EPT laszip) reads this
 * offset and passes the byte through {@link normalizeClassificationFlagsByte}
 * — the single place that knows how to unpack either layout.
 */
export const RECORD_CLASSIFICATION_FLAGS_OFFSET = 15;

/**
 * Normalise a raw classification-flags source byte into the one nibble layout
 * the rest of the app reads (bit0 Synthetic, bit1 Key-point, bit2 Withheld,
 * bit3 Overlap — the extended Table 16 layout). Extended records keep the
 * flags in the low nibble of their own byte; legacy records pack Synthetic,
 * Key-Point and Withheld into bits 5, 6 and 7 of the classification byte
 * (Overlap has no legacy flag — it is class 12 instead, decoded elsewhere).
 *
 * This is the ONE place that unpacks either layout: every decoder that reads
 * raw LAS/LAZ-family records — static `.las`/`.laz`, COPC, EPT laszip — calls
 * this rather than re-deriving the bit shifts, so a correction lands once.
 */
export function normalizeClassificationFlagsByte(byte: number, extended: boolean): number {
  return extended
    ? byte & 0x0f
    : ((byte & 0x20) >> 5) | ((byte & 0x40) >> 5) | ((byte & 0x80) >> 5);
}
/**
 * Scan angle source byte offset. Legacy records hold a signed int8 "scan
 * angle rank" at byte 16, already whole degrees. Extended records hold a
 * signed int16 "scan angle" at byte 18, in units of 0.006 degrees — Table 8 /
 * Table 17 of the LAS 1.4 R15 spec (Table 8: legacy formats 0-5, byte offset
 * 16, "Scan Angle Rank", signed char, -90 to +90; Table 17: extended formats
 * 6-10, byte offset 18, "Scan Angle", signed short, unit 0.006°).
 */
export const RECORD_SCAN_ANGLE_LEGACY = 16;
export const RECORD_SCAN_ANGLE_EXT = 18;
/** Extended scan-angle LSB, in degrees (Table 17). */
const SCAN_ANGLE_EXTENDED_UNIT_DEG = 0.006;
/** User data — uint8 — byte 17 in both the legacy and extended layouts. */
export const RECORD_USER_DATA_OFFSET = 17;
/** Point source ID — uint16 LE — byte 18 in legacy records, byte 20 in extended. */
export const RECORD_POINT_SOURCE_ID_LEGACY = 18;
export const RECORD_POINT_SOURCE_ID_EXT = 20;

/**
 * Convert a raw scan-angle field to degrees. Legacy records already store
 * whole degrees (the "rank"); extended records store a signed int16 in
 * 0.006° steps, so a raw value of -15000 is -90°.
 */
export function scanAngleToDegrees(raw: number, extended: boolean): number {
  return extended ? raw * SCAN_ANGLE_EXTENDED_UNIT_DEG : raw;
}

/**
 * Extract one single-bit flag from a byte. Used for scan-direction and
 * edge-of-flight-line, which share the same bit position (6 and 7
 * respectively) whether they come from the legacy return-bits byte or the
 * extended flags byte — only the SOURCE byte differs between layouts, not the
 * bit position, so one helper serves both.
 */
export function extractBitFlag(byte: number, bit: number): number {
  return (byte >> bit) & 1;
}

/**
 * Scanner channel — extended records only (bits 4-5 of the flags byte at
 * {@link RECORD_CLASSIFICATION_FLAGS_OFFSET}, Table 17). Legacy records have
 * no scanner-channel concept, so callers gate this behind `ctx.extended`.
 */
export function extractScannerChannel(flagByte: number): number {
  return (flagByte >> 4) & 0x03;
}
/** GPS time — float64 LE — byte 20 in legacy GPS records, byte 22 in extended. */
export const RECORD_GPS_TIME_LEGACY = 20;
export const RECORD_GPS_TIME_EXT = 22;
/** First point format index that uses the extended record layout. */
export const FIRST_EXTENDED_FORMAT = 6;
/** Legacy point formats (0-5) that carry a GPS-time field. */
const LEGACY_GPS_FORMATS: ReadonlySet<number> = new Set([1, 3, 4, 5]);

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
  if (!extended && !LEGACY_GPS_FORMATS.has(header.pointFormat)) return null;
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
  /**
   * Classification flags, one byte per point, always in the extended layout
   * (Synthetic 1, Key-Point 2, Withheld 4, Overlap 8) whatever the source
   * format used. Legacy records carry the first three in bits 5 to 7 of the
   * classification byte and express overlap as class 12 instead, so
   * normalising here means one representation reaches the rest of the app.
   */
  classificationFlags: Uint8Array;
  returnNumber: Uint8Array;
  returnCount: Uint8Array;
  /**
   * Scan angle in degrees — see {@link scanAngleToDegrees}. Every LAS record
   * has one, but a caller that will discard it (the out-of-core tile path,
   * whose packed schema carries none of these five channels) can skip the
   * allocation via `allocRawPoints`'s `pointSemantics` option — null there, never
   * a wastefully-filled array nobody reads.
   */
  scanAngle: Float32Array | null;
  /** User data — see {@link scanAngle} for when this is null. */
  userData: Uint8Array | null;
  /**
   * Scanner channel (bits 4-5 of the extended flags byte). Null for a
   * legacy-format file (Table 17 is extended-only) OR when `pointSemantics` is
   * off — see {@link scanAngle}.
   */
  scannerChannel: Uint8Array | null;
  /** Scan direction flag, 0 or 1 — see {@link scanAngle} for when this is null. */
  scanDirection: Uint8Array | null;
  /** Edge-of-flight-line flag, 0 or 1 — see {@link scanAngle} for when this is null. */
  edgeOfFlightLine: Uint8Array | null;
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
  /** Byte holding the flags: its own byte when extended, the class byte when not. */
  classificationFlagsOffset: number;
  extended: boolean;
  scanAngleOffset: number;
  userDataOffset: number;
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
    classificationFlagsOffset: RECORD_CLASSIFICATION_FLAGS_OFFSET,
    extended,
    scanAngleOffset: extended ? RECORD_SCAN_ANGLE_EXT : RECORD_SCAN_ANGLE_LEGACY,
    userDataOffset: RECORD_USER_DATA_OFFSET,
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
  const flagByte = view.getUint8(base + ctx.classificationFlagsOffset);
  out.classificationFlags[i] = normalizeClassificationFlagsByte(flagByte, ctx.extended);
  const returnBits = view.getUint8(base + RECORD_RETURN_BITS);
  if (ctx.extended) {
    out.returnNumber[i] = returnBits & 0x0f;
    out.returnCount[i] = (returnBits >> 4) & 0x0f;
  } else {
    out.returnNumber[i] = returnBits & 0x07;
    out.returnCount[i] = (returnBits >> 3) & 0x07;
  }
  // Scan direction and edge-of-flight-line share bit 6 and bit 7 in both
  // layouts, but the SOURCE byte differs: the legacy return-bits byte
  // already read above, or the extended flags byte read above for the
  // classification flags.
  const directionSourceByte = ctx.extended ? flagByte : returnBits;
  if (out.scanDirection !== null) {
    out.scanDirection[i] = extractBitFlag(directionSourceByte, 6);
    out.edgeOfFlightLine![i] = extractBitFlag(directionSourceByte, 7);
  }
  if (out.scannerChannel !== null) {
    out.scannerChannel[i] = extractScannerChannel(flagByte);
  }
  if (out.scanAngle !== null) {
    const scanAngleRaw = ctx.extended
      ? view.getInt16(base + ctx.scanAngleOffset, true)
      : view.getInt8(base + ctx.scanAngleOffset);
    out.scanAngle[i] = scanAngleToDegrees(scanAngleRaw, ctx.extended);
  }
  if (out.userData !== null) out.userData[i] = view.getUint8(base + ctx.userDataOffset);
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

/**
 * `pointSemantics` gates scan angle, user data, scanner channel, scan
 * direction and edge-of-flight-line — five channels every LAS record HAS,
 * but which cost real bytes and CPU to decode. Default OFF everywhere, so
 * `undefined` on a decoded cloud or chunk means either "not decoded" (the
 * common case, `pointSemantics` is off) or "not present in the source" — a
 * consumer that needs to tell those apart must itself request the channels
 * (`pointSemantics: true`) and only then does `undefined` mean the source
 * genuinely lacks them (true for `scannerChannel` on a legacy-format file).
 * `classificationFlags` is NOT gated by this option — it stays always-on,
 * one byte per point, because the Withheld policy reads it.
 */
export interface AllocRawPointsOptions {
  pointSemantics?: boolean;
}

export function allocRawPoints(
  count: number,
  hasGpsTime: boolean,
  hasColor = false,
  extended = false,
  options: AllocRawPointsOptions = {},
): RawPoints {
  const pointSemantics = options.pointSemantics ?? false;
  return {
    positions: new Float32Array(count * 3),
    intensity: new Uint16Array(count),
    classification: new Uint8Array(count),
    classificationFlags: new Uint8Array(count),
    returnNumber: new Uint8Array(count),
    returnCount: new Uint8Array(count),
    scanAngle: pointSemantics ? new Float32Array(count) : null,
    userData: pointSemantics ? new Uint8Array(count) : null,
    // Scanner channel is a Table 17 extended-only field — legacy records
    // have nothing to report, so the array itself is absent rather than
    // zero-filled — same as when `pointSemantics` is off.
    scannerChannel: pointSemantics && extended ? new Uint8Array(count) : null,
    scanDirection: pointSemantics ? new Uint8Array(count) : null,
    edgeOfFlightLine: pointSemantics ? new Uint8Array(count) : null,
    pointSourceId: new Uint16Array(count),
    gpsTime: hasGpsTime ? new Float64Array(count) : null,
    // Colour is staged as raw 16-bit and narrowed once in finalizeRawColors;
    // `colors` (the 8-bit render buffer) is allocated there.
    colors: null,
    colors16: hasColor ? new Uint16Array(count * 3) : null,
  };
}

/** Legacy point formats (0-5) whose record carries an RGB triple. */
const LEGACY_RGB_FORMATS: ReadonlySet<number> = new Set([2, 3, 5]);
/** Extended point formats (6-10) whose record carries an RGB triple. */
const EXTENDED_RGB_FORMATS: ReadonlySet<number> = new Set([7, 8, 10]);

/**
 * The TRUE resident bytes one point costs in a `RawPoints` allocated by
 * {@link allocRawPoints} for `pointFormat`, with the same `pointSemantics`
 * choice (default off, matching `allocRawPoints`'s own default) — derived
 * from the exact same field list (and the same GPS-time / RGB format rules
 * {@link gpsTimeOffsetFor} / {@link rgbOffsetFor} use) so the two functions
 * cannot drift apart. Colour is charged at its WORST-CASE transient cost: the
 * 16-bit staging buffer (6 bytes) plus the narrowed 8-bit one (3 bytes) are
 * resident together while `finalizeRawColors` runs, mirroring the
 * `colors16`/`colors` pair `allocRawPoints` stages.
 *
 * Used to size a budget check against the allocation it actually protects,
 * not against the source record length — `RawPoints` is wider than the LAS
 * record for every point format, since it always carries the
 * classification-flags channel and, when `pointSemantics` is on, the five
 * point-semantics channels too — so a budget keyed on record length alone
 * would pass a decode that allocates past it.
 */
export function rawPointsBytesPerPoint(
  pointFormat: number,
  options: AllocRawPointsOptions = {},
): number {
  const pointSemantics = options.pointSemantics ?? false;
  const extended = pointFormat >= FIRST_EXTENDED_FORMAT;
  const hasGpsTime = extended || LEGACY_GPS_FORMATS.has(pointFormat);
  const hasColor = extended
    ? EXTENDED_RGB_FORMATS.has(pointFormat)
    : LEGACY_RGB_FORMATS.has(pointFormat);
  let bytes =
    12 /* positions: Float32 * 3 */ +
    2 /* intensity: Uint16 */ +
    1 /* classification: Uint8 */ +
    1 /* classificationFlags: Uint8 */ +
    1 /* returnNumber: Uint8 */ +
    1 /* returnCount: Uint8 */ +
    2 /* pointSourceId: Uint16 */;
  if (pointSemantics) {
    bytes += 4 /* scanAngle: Float32 */ + 1 /* userData: Uint8 */;
    bytes += 1 /* scanDirection: Uint8 */ + 1 /* edgeOfFlightLine: Uint8 */;
    if (extended) bytes += 1; /* scannerChannel: Uint8 */
  }
  if (hasGpsTime) bytes += 8; /* Float64 */
  if (hasColor) bytes += 6 + 3; /* colors16 staging + narrowed colors, coexisting */
  return bytes;
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
  for (const v of src) {
    if (v > maxRgb) maxRgb = v;
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

/**
 * The transferable backing buffers of a chunk-local {@link RawPoints}, so a
 * decode worker can hand its result back to the main thread zero-copy. Colours
 * are still STAGED here (`colors16`); the 8-bit-vs-16-bit narrowing is the
 * caller's single per-file decision, so `colors` is null on a worker's output
 * and only `colors16`, when the format carries colour, is transferred. Every
 * present typed array is listed exactly once — a buffer left off the list would
 * be structure-cloned (a silent copy), which is the whole cost the chunked path
 * exists to avoid.
 */
export function rawPointsTransferables(raw: RawPoints): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [
    raw.positions.buffer as ArrayBuffer,
    raw.intensity.buffer as ArrayBuffer,
    raw.classification.buffer as ArrayBuffer,
    raw.classificationFlags.buffer as ArrayBuffer,
    raw.returnNumber.buffer as ArrayBuffer,
    raw.returnCount.buffer as ArrayBuffer,
    raw.pointSourceId.buffer as ArrayBuffer,
  ];
  if (raw.scanAngle) buffers.push(raw.scanAngle.buffer as ArrayBuffer);
  if (raw.userData) buffers.push(raw.userData.buffer as ArrayBuffer);
  if (raw.scanDirection) buffers.push(raw.scanDirection.buffer as ArrayBuffer);
  if (raw.edgeOfFlightLine) buffers.push(raw.edgeOfFlightLine.buffer as ArrayBuffer);
  if (raw.scannerChannel) buffers.push(raw.scannerChannel.buffer as ArrayBuffer);
  if (raw.gpsTime) buffers.push(raw.gpsTime.buffer as ArrayBuffer);
  if (raw.colors16) buffers.push(raw.colors16.buffer as ArrayBuffer);
  return buffers;
}

export function decodingUpdate(done: number, total: number): ProgressUpdate {
  return {
    stage: 'decoding',
    detail: `${formatPointCount(done)} of ${formatPointCount(total)} points`,
    fraction: total > 0 ? Math.min(1, done / total) : 1,
  };
}
