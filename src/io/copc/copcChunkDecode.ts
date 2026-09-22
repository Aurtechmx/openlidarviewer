/**
 * copcChunkDecode.ts
 *
 * The `ChunkDecoder` interface and the pure decoding of raw LAS PDRF 6/7/8
 * point records into local-space attribute arrays.
 *
 * `decodeRecords` is the half of COPC decoding that needs no WASM: given the
 * *already-decompressed* records (the worker produces these via laz-perf), it
 * extracts positions, colour, intensity, classification, returns and GPS time.
 * It applies the coordinate bridge — `scaled · scale + offset` then the
 * render-origin subtraction, all in float64, with a single float32 store — so
 * survey-scale coordinates keep their precision.
 *
 * Pure — no DOM, no three.js, no WASM. The laz-perf decompression step lives
 * in `worker/copcWorker.ts`; this module is fully unit-tested in Node.
 */

import { assertFiniteNodeTransform, assertFinitePositions } from '../streamingFiniteGuard';
import {
  normalizeClassificationFlagsByte,
  RECORD_CLASSIFICATION_FLAGS_OFFSET,
  RECORD_USER_DATA_OFFSET,
  RECORD_SCAN_ANGLE_EXT,
  RECORD_POINT_SOURCE_ID_EXT,
  RECORD_GPS_TIME_EXT,
  rawPointsBytesPerPoint,
  scanAngleToDegrees,
  extractBitFlag,
  extractScannerChannel,
} from '../lasDecodeShared';

/** Per-chunk decode parameters. */
export interface ChunkDecodeMetadata {
  /** LAS point data record format — 6, 7, or 8. */
  pointDataRecordFormat: number;
  /** LAS point record length, in bytes. */
  pointRecordLength: number;
  /** Number of points in this chunk. */
  pointCount: number;
  /** LAS scale factors. */
  scale: [number, number, number];
  /** LAS offsets. */
  offset: [number, number, number];
  /** Render origin, subtracted in float64 before the float32 store. */
  renderOrigin: [number, number, number];
  /**
   * File-level RGB bit-depth decision. When set, every chunk narrows colour the
   * SAME way (8-bit-in-low-byte copied verbatim vs 16-bit high-byte) instead of
   * each chunk deciding from its own max — so a cloud can't show two nodes in
   * different colour depths. The source captures it from the first decoded RGB
   * chunk (see {@link DecodedChunk.rgbEightBit}) and feeds it back here.
   */
  rgbEightBit?: boolean;
  /**
   * Decode scan angle, user data, scanner channel, scan direction and
   * edge-of-flight-line. Default off — see `lasDecodeShared.ts`'s
   * `AllocRawPointsOptions` doc for what `undefined` means on the resulting
   * chunk when this is left off vs turned on.
   */
  pointSemantics?: boolean;
}

/**
 * A decoded node chunk — local-space attributes ready for the GPU.
 *
 * Only `pointCount` and `positions` are required. Every measured channel is
 * optional because the chunk shape serves more than the LAS family: a `.pnts`
 * tile carries none of intensity, classification, returns or GPS time, and
 * allocating zero-filled arrays for them would spend 13 bytes per point saying
 * something false. An ABSENT channel and a channel of zeros are different
 * claims — zero classification means "never classified" and zero intensity is
 * not a measured zero — so a reader must be able to tell them apart.
 *
 * A consumer that needs a channel checks for it. Colour modes are gated by the
 * source's `colorModes()`, so a mode is never offered for a channel the format
 * cannot fill; the derived products (resident snapshot, profile section, point
 * inspector) report absence rather than substituting a default.
 *
 * The LAS-family decoders — COPC, EPT and the out-of-core tile store — fill
 * most of these on every chunk and are unaffected by the optionality; only
 * `classificationFlags` genuinely varies by source (see its own doc).
 */
export interface DecodedChunk {
  /** Points actually decoded (≤ the requested count if the input was short). */
  pointCount: number;
  /** Local-space positions, length `3 · pointCount`. */
  positions: Float32Array;
  /** Per-point intensity — absent when the format carries none. */
  intensity?: Uint16Array;
  /** Per-point classification — absent when the format carries none. */
  classification?: Uint8Array;
  /**
   * Per-point classification flags (bit0 Synthetic, bit1 Key-point, bit2
   * Withheld, bit3 Overlap — the normalised nibble {@link
   * normalizeClassificationFlagsByte} produces), one byte per point. Absent
   * when the source genuinely carries no flags channel — never a zero array,
   * since zero means "none of the flags are set" and absence means "not
   * recorded."
   */
  classificationFlags?: Uint8Array;
  /** Per-point return number — absent when the format carries none. */
  returnNumber?: Uint8Array;
  /** Per-point total returns — absent when the format carries none. */
  returnCount?: Uint8Array;
  /** Per-point scan angle, in degrees — absent when the format carries none. */
  scanAngle?: Float32Array;
  /** Per-point user data byte — absent when the format carries none. */
  userData?: Uint8Array;
  /**
   * Per-point scanner channel — COPC nodes are always an extended point
   * format (PDRF 6/7/8), so this is always present for a COPC chunk.
   */
  scannerChannel?: Uint8Array;
  /** Per-point scan direction flag (0/1) — absent when the format carries none. */
  scanDirection?: Uint8Array;
  /** Per-point edge-of-flight-line flag (0/1) — absent when the format carries none. */
  edgeOfFlightLine?: Uint8Array;
  /** Per-point GPS time — absent when the format carries none. */
  gpsTime?: Float64Array;
  /** Per-point point source id — produced by `decodeRecords`, absent on fakes. */
  pointSourceId?: Uint16Array;
  /** Per-point RGB (0-255), length `3 · pointCount` — only for PDRF 7/8. */
  rgb?: Uint8Array;
  /**
   * Per-point surface normals, interleaved xyz, length `3 · pointCount`.
   *
   * Absent for the whole LAS family: a PDRF 6/7/8 record reserves no field for
   * one. A `.pnts` tile can state them, through either a float32 `NORMAL` or an
   * oct-encoded `NORMAL_OCT16P` accessor, and that is the only source that
   * fills this today.
   *
   * A normal is a MEASUREMENT, so this is never synthesised, defaulted or
   * zero-filled. A zero triple is not "no normal": it is a degenerate direction,
   * and a consumer cannot tell the two apart once one has been written. Absence
   * is the only honest way to say the surface was never measured.
   */
  normals?: Float32Array;
  /**
   * The RGB bit-depth decision this chunk used (true = 8-bit-in-low-byte copied
   * verbatim, false = 16-bit high-byte). Undefined when the chunk carries no
   * RGB. The source reads it off the first RGB chunk and feeds it back as
   * {@link ChunkDecodeMetadata.rgbEightBit} so all later chunks match.
   */
  rgbEightBit?: boolean;
}

/**
 * Decodes one node's bytes into local-space attributes.
 *
 * The metadata type is a parameter because the scheduler never inspects it: it
 * takes whatever the source returns and hands it to the decoder that source was
 * built with. A LAZ decoder keeps the default and is unchanged; a decoder for
 * another body, such as a `.pnts` tile, names its own metadata instead.
 */
export interface ChunkDecoder<TMeta = ChunkDecodeMetadata> {
  decode(chunk: ArrayBuffer, meta: TMeta, signal?: AbortSignal): Promise<DecodedChunk>;
}

/**
 * Peak decoded channel-array bytes per point for one PDRF 6/7/8 node, matching
 * exactly what {@link decodeRecords} allocates and holds LIVE at once. Derived
 * from {@link rawPointsBytesPerPoint} — the same per-format width formula the
 * static LAS/LAZ decoder and the byte-budget guards use — so this cannot drift
 * from what `decodeRecords` actually allocates for the same `pdrf` and
 * `pointSemantics`. PDRF 7 and 8's colour is charged at 9, not 3: the staged
 * Uint16 rgb16 (3 · 2 = 6) and the narrowed Uint8 rgb (3) are both RESIDENT
 * while the narrow loop runs. PDRF 8's NIR is not decoded, so it is not
 * charged. Returns {@link Number.POSITIVE_INFINITY} for a non-usable count so
 * a nonsense value reads as over-budget rather than as zero.
 */
export function copcDecodedChannelBytes(
  pdrf: number,
  pointCount: number,
  pointSemantics = false,
): number {
  if (!Number.isFinite(pointCount) || pointCount < 0) return Number.POSITIVE_INFINITY;
  return pointCount * rawPointsBytesPerPoint(pdrf, { pointSemantics });
}

/** RGB triple offset in PDRF 7 and 8. */
const RGB_OFFSET = 30;

/**
 * Decode raw (decompressed) LAS PDRF 6/7/8 records into a {@link DecodedChunk}.
 *
 * If `raw` is shorter than `pointCount · pointRecordLength` — a truncated or
 * partial decode — the point count is clamped to what is actually present,
 * never read past the buffer.
 */
export function decodeRecords(
  raw: Uint8Array,
  meta: ChunkDecodeMetadata,
): DecodedChunk {
  const len = meta.pointRecordLength;
  const n = Math.max(0, Math.min(meta.pointCount, Math.floor(raw.byteLength / len)));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  // Fail fast before decoding a whole node when its transform is outright
  // non-finite (a NaN/Inf scale, offset, or render origin from a bad header).
  // This is the cheap common case; it does NOT catch a transform that is finite
  // but so extreme that `int32 · scale + offset` overflows to Infinity, so the
  // finished positions are scanned once below as the backstop.
  assertFiniteNodeTransform(meta.scale, meta.offset, meta.renderOrigin);
  const [sx, sy, sz] = meta.scale;
  const [ox, oy, oz] = meta.offset;
  const [rx, ry, rz] = meta.renderOrigin;
  const hasRgb = meta.pointDataRecordFormat === 7 || meta.pointDataRecordFormat === 8;
  const pointSemantics = meta.pointSemantics ?? false;

  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  // COPC is always an extended point format (PDRF 6/7/8), so the flags byte
  // is always unpacked as the extended layout — see
  // `RECORD_CLASSIFICATION_FLAGS_OFFSET` / `normalizeClassificationFlagsByte`.
  const classificationFlags = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  // Scan angle / user data / scanner channel / scan direction /
  // edge-of-flight-line decode only when the caller opts in — see
  // `AllocRawPointsOptions` in lasDecodeShared.ts for what `undefined` on the
  // resulting chunk means in each state.
  const scanAngle = pointSemantics ? new Float32Array(n) : undefined;
  const userData = pointSemantics ? new Uint8Array(n) : undefined;
  // COPC is always an extended point format, so scanner channel is always
  // materialised when `pointSemantics` is on — unlike EPT laszip, which also
  // serves legacy PDRFs.
  const scannerChannel = pointSemantics ? new Uint8Array(n) : undefined;
  const scanDirection = pointSemantics ? new Uint8Array(n) : undefined;
  const edgeOfFlightLine = pointSemantics ? new Uint8Array(n) : undefined;
  const gpsTime = new Float64Array(n);
  const pointSourceId = new Uint16Array(n);
  const rgb16 = hasRgb ? new Uint16Array(n * 3) : undefined;
  let maxRgb = 0;

  for (let i = 0; i < n; i++) {
    const p = i * len;
    // Coordinate bridge: f64 scale/offset, f64 origin subtraction, f32 store.
    positions[i * 3] = view.getInt32(p, true) * sx + ox - rx;
    positions[i * 3 + 1] = view.getInt32(p + 4, true) * sy + oy - ry;
    positions[i * 3 + 2] = view.getInt32(p + 8, true) * sz + oz - rz;

    intensity[i] = view.getUint16(p + 12, true);
    const returnByte = view.getUint8(p + 14);
    returnNumber[i] = returnByte & 0x0f;
    returnCount[i] = (returnByte >> 4) & 0x0f;
    classification[i] = view.getUint8(p + 16);
    const flagByte = view.getUint8(p + RECORD_CLASSIFICATION_FLAGS_OFFSET);
    classificationFlags[i] = normalizeClassificationFlagsByte(flagByte, true);
    if (pointSemantics) {
      // Scan direction and edge-of-flight-line live in bits 6/7 of the same
      // extended flags byte the classification flags come from.
      scanDirection![i] = extractBitFlag(flagByte, 6);
      edgeOfFlightLine![i] = extractBitFlag(flagByte, 7);
      scannerChannel![i] = extractScannerChannel(flagByte);
      scanAngle![i] = scanAngleToDegrees(view.getInt16(p + RECORD_SCAN_ANGLE_EXT, true), true);
      userData![i] = view.getUint8(p + RECORD_USER_DATA_OFFSET);
    }
    pointSourceId[i] = view.getUint16(p + RECORD_POINT_SOURCE_ID_EXT, true);
    gpsTime[i] = view.getFloat64(p + RECORD_GPS_TIME_EXT, true);

    if (rgb16) {
      const r = view.getUint16(p + RGB_OFFSET, true);
      const g = view.getUint16(p + RGB_OFFSET + 2, true);
      const b = view.getUint16(p + RGB_OFFSET + 4, true);
      rgb16[i * 3] = r;
      rgb16[i * 3 + 1] = g;
      rgb16[i * 3 + 2] = b;
      if (r > maxRgb) maxRgb = r;
      if (g > maxRgb) maxRgb = g;
      if (b > maxRgb) maxRgb = b;
    }
  }

  let rgb: Uint8Array | undefined;
  let rgbEightBit: boolean | undefined;
  if (rgb16) {
    rgb = new Uint8Array(n * 3);
    // LAS RGB is nominally 16-bit; some writers store 8-bit values in the low
    // byte. Prefer the file-level decision the source passed (so every node of a
    // cloud narrows identically); otherwise fall back to this chunk's own max —
    // ≤ 255 ⇒ 8-bit-in-low-byte (copied verbatim), else 16-bit (high byte).
    rgbEightBit = meta.rgbEightBit ?? (maxRgb <= 255);
    for (let i = 0; i < rgb16.length; i++) {
      rgb[i] = rgbEightBit ? rgb16[i] : rgb16[i] >> 8;
    }
  }

  // Backstop the up-front transform check: a finite-but-extreme scale/offset can
  // still overflow a coordinate to ±Infinity, so refuse the node if any did.
  assertFinitePositions(positions);

  return {
    pointCount: n,
    positions,
    intensity,
    classification,
    classificationFlags,
    returnNumber,
    returnCount,
    scanAngle,
    userData,
    scannerChannel,
    scanDirection,
    edgeOfFlightLine,
    gpsTime,
    pointSourceId,
    rgb,
    rgbEightBit,
  };
}

/**
 * The transferable buffers of a decoded chunk — for zero-copy `postMessage`.
 * Each attribute array is created fresh in {@link decodeRecords}, so its
 * backing buffer is always a real `ArrayBuffer`. Channels the chunk does not
 * carry contribute nothing.
 */
export function chunkTransferables(decoded: DecodedChunk): ArrayBuffer[] {
  const out: ArrayBuffer[] = [decoded.positions.buffer as ArrayBuffer];
  // Every measured channel is optional on the chunk, so each is transferred
  // only when the decoder produced it. Listing an absent one would post a
  // buffer that is not there.
  if (decoded.intensity) out.push(decoded.intensity.buffer as ArrayBuffer);
  if (decoded.classification) out.push(decoded.classification.buffer as ArrayBuffer);
  if (decoded.classificationFlags) out.push(decoded.classificationFlags.buffer as ArrayBuffer);
  if (decoded.returnNumber) out.push(decoded.returnNumber.buffer as ArrayBuffer);
  if (decoded.returnCount) out.push(decoded.returnCount.buffer as ArrayBuffer);
  if (decoded.scanAngle) out.push(decoded.scanAngle.buffer as ArrayBuffer);
  if (decoded.userData) out.push(decoded.userData.buffer as ArrayBuffer);
  if (decoded.scannerChannel) out.push(decoded.scannerChannel.buffer as ArrayBuffer);
  if (decoded.scanDirection) out.push(decoded.scanDirection.buffer as ArrayBuffer);
  if (decoded.edgeOfFlightLine) out.push(decoded.edgeOfFlightLine.buffer as ArrayBuffer);
  if (decoded.gpsTime) out.push(decoded.gpsTime.buffer as ArrayBuffer);
  if (decoded.pointSourceId) out.push(decoded.pointSourceId.buffer as ArrayBuffer);
  if (decoded.rgb) out.push(decoded.rgb.buffer as ArrayBuffer);
  if (decoded.normals) out.push(decoded.normals.buffer as ArrayBuffer);
  return out;
}

