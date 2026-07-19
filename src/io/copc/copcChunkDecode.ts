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
}

/** A decoded COPC node chunk — local-space attributes ready for the GPU. */
export interface DecodedChunk {
  /** Points actually decoded (≤ the requested count if the input was short). */
  pointCount: number;
  /** Local-space positions, length `3 · pointCount`. */
  positions: Float32Array;
  /** Per-point intensity. */
  intensity: Uint16Array;
  /** Per-point classification. */
  classification: Uint8Array;
  /** Per-point return number. */
  returnNumber: Uint8Array;
  /** Per-point total returns. */
  returnCount: Uint8Array;
  /** Per-point GPS time. */
  gpsTime: Float64Array;
  /** Per-point point source id — produced by `decodeRecords`, absent on fakes. */
  pointSourceId?: Uint16Array;
  /** Per-point RGB (0-255), length `3 · pointCount` — only for PDRF 7/8. */
  rgb?: Uint8Array;
  /**
   * The RGB bit-depth decision this chunk used (true = 8-bit-in-low-byte copied
   * verbatim, false = 16-bit high-byte). Undefined when the chunk carries no
   * RGB. The source reads it off the first RGB chunk and feeds it back as
   * {@link ChunkDecodeMetadata.rgbEightBit} so all later chunks match.
   */
  rgbEightBit?: boolean;
}

/** Decodes a compressed COPC node chunk into local-space attributes. */
export interface ChunkDecoder {
  decode(
    chunk: ArrayBuffer,
    meta: ChunkDecodeMetadata,
    signal?: AbortSignal,
  ): Promise<DecodedChunk>;
}

/** Point source id offset in PDRF 6, 7, and 8. */
const POINT_SOURCE_ID_OFFSET = 20;
/** GPS time lives at the same offset in PDRF 6, 7, and 8. */
const GPS_TIME_OFFSET = 22;
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

  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
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
    pointSourceId[i] = view.getUint16(p + POINT_SOURCE_ID_OFFSET, true);
    gpsTime[i] = view.getFloat64(p + GPS_TIME_OFFSET, true);

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
    returnNumber,
    returnCount,
    gpsTime,
    pointSourceId,
    rgb,
    rgbEightBit,
  };
}

/**
 * The transferable buffers of a decoded chunk — for zero-copy `postMessage`.
 * Each attribute array is created fresh in {@link decodeRecords}, so its
 * backing buffer is always a real `ArrayBuffer`.
 */
export function chunkTransferables(decoded: DecodedChunk): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    decoded.positions.buffer as ArrayBuffer,
    decoded.intensity.buffer as ArrayBuffer,
    decoded.classification.buffer as ArrayBuffer,
    decoded.returnNumber.buffer as ArrayBuffer,
    decoded.returnCount.buffer as ArrayBuffer,
    decoded.gpsTime.buffer as ArrayBuffer,
  ];
  if (decoded.pointSourceId) out.push(decoded.pointSourceId.buffer as ArrayBuffer);
  if (decoded.rgb) out.push(decoded.rgb.buffer as ArrayBuffer);
  return out;
}
