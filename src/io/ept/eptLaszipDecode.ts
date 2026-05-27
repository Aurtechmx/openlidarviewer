/**
 * eptLaszipDecode.ts
 *
 * Decode an EPT `dataType: laszip` tile into the `DecodedChunk` shape the
 * StreamingRenderer + scheduler consume.
 *
 * **Why this exists (not a copy of the COPC decoder):** the COPC worker
 * is fed *raw decompressed* LAZ chunks — the COPC file structure pre-
 * extracts each octree node's compressed bytes, and the worker reads
 * the LAS public header ONCE for the whole file to know PDRF + scale +
 * offset. EPT laszip tiles are different: each tile is a COMPLETE LAZ
 * file (with its own LAS public header and its own LAZ stream). So the
 * per-tile flow is:
 *
 *   1. Parse the per-tile LAS public header → discover PDRF, scale,
 *      offset, point count, record length.
 *   2. Decompress the LAZ stream via laz-perf (same cached WASM module
 *      the static loadLas + COPC worker both use).
 *   3. Walk each decompressed record, apply the per-tile scale/offset
 *      to recover absolute world coordinates, then subtract the EPT
 *      cloud's render origin in Float64 BEFORE narrowing to Float32.
 *      Preserves the precision contract from `docs/coordinate-precision.md`.
 *
 * **Threading note:** the v0.3.3 MVP runs on the main thread (laz-perf
 * is fast on small EPT tiles — typical tile sizes are 10k–50k points,
 * decode <30 ms). For high-tile-rate streaming a worker dispatcher
 * lands in a follow-up session; the EPT chunk-decoder's seam already
 * supports the swap (`EptChunkDecoder.decode` is async).
 *
 * **Supported point formats:** PDRF 0-3 (legacy, no GPS time / GPS time)
 * and PDRF 6-8 (extended). Other formats throw a typed error so the
 * Studio gates surface a clear message instead of producing garbage.
 *
 * Pure of three.js. Async only through the laz-perf WASM initialisation
 * promise (cached after the first call across the entire session).
 */

import { parseLasHeader } from '../lasHeader';
import { getLazPerf } from '../loadLas';
import type { DecodedChunk } from '../copc/copcChunkDecode';

// ─────────────────────────────────────────────────────────────────────────────
// LAS record-layout constants — minimal subset the decoder needs. Mirrors
// the offsets in loadLas.ts; kept inline rather than re-exported so EPT
// doesn't accumulate a coupling-debt against the static-LAS implementation.
// ─────────────────────────────────────────────────────────────────────────────

/** Byte offset of the intensity field within a point record. */
const RECORD_INTENSITY = 12;
/** Byte offset of the return-bits byte in legacy formats (0-5). */
const RECORD_RETURN_BITS_LEGACY = 14;
/** Byte offset of the return-bits byte in extended formats (6-10). */
const RECORD_RETURN_BITS_EXT = 14;  // legacy convention; extended widens bits
/** Byte offset of the classification field in legacy formats. */
const RECORD_CLASSIFICATION_LEGACY = 15;
/** Byte offset of the classification field in extended formats. */
const RECORD_CLASSIFICATION_EXT = 16;
/** Byte offset of point source ID in legacy formats. */
const RECORD_POINT_SOURCE_LEGACY = 18;
/** Byte offset of point source ID in extended formats. */
const RECORD_POINT_SOURCE_EXT = 20;
/** Byte offset of GPS time in legacy format 1/3. */
const RECORD_GPS_TIME_LEGACY_1_3 = 20;
/** Byte offset of GPS time in extended format 6-8. */
const RECORD_GPS_TIME_EXT = 22;
/** Byte offset of RGB triple in PDRF 2, 3, 5 (legacy). */
const RECORD_RGB_LEGACY_2 = 20;     // PDRF 2 has no GPS time → RGB at 20
const RECORD_RGB_LEGACY_3 = 28;     // PDRF 3 has GPS time at 20-27 → RGB at 28
/** Byte offset of RGB triple in PDRF 7, 8 (extended). */
const RECORD_RGB_EXT_7 = 30;

/** First extended (PDRF ≥ 6) point format. */
const FIRST_EXTENDED_FORMAT = 6;

// ─────────────────────────────────────────────────────────────────────────────
// Per-tile decode context — precomputed once per tile.
// ─────────────────────────────────────────────────────────────────────────────

interface TileDecodeContext {
  readonly pdrf: number;
  readonly recordLength: number;
  readonly pointCount: number;
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly extended: boolean;
  readonly hasRgb: boolean;
  readonly hasGpsTime: boolean;
  readonly classificationOffset: number;
  readonly pointSourceOffset: number;
  readonly gpsTimeOffset: number | null;
  readonly rgbOffset: number | null;
}

/** Build the per-tile decode context from a parsed header. */
function buildContext(buffer: ArrayBuffer): TileDecodeContext {
  const header = parseLasHeader(buffer);
  const pdrf = header.pointFormat;
  if (![0, 1, 2, 3, 6, 7, 8].includes(pdrf)) {
    throw new Error(
      `EPT laszip decode: unsupported LAS point data record format ${pdrf}. ` +
      `Supported formats: 0, 1, 2, 3, 6, 7, 8.`,
    );
  }
  const extended = pdrf >= FIRST_EXTENDED_FORMAT;
  const hasGpsTime = pdrf === 1 || pdrf === 3 || extended;
  const hasRgb = pdrf === 2 || pdrf === 3 || pdrf === 7 || pdrf === 8;

  let gpsTimeOffset: number | null = null;
  if (pdrf === 1 || pdrf === 3) gpsTimeOffset = RECORD_GPS_TIME_LEGACY_1_3;
  else if (extended) gpsTimeOffset = RECORD_GPS_TIME_EXT;

  let rgbOffset: number | null = null;
  if (pdrf === 2) rgbOffset = RECORD_RGB_LEGACY_2;
  else if (pdrf === 3) rgbOffset = RECORD_RGB_LEGACY_3;
  else if (pdrf === 7 || pdrf === 8) rgbOffset = RECORD_RGB_EXT_7;

  return {
    pdrf,
    recordLength: header.pointDataRecordLength,
    pointCount: header.pointCount,
    scale: header.scale,
    offset: header.offset,
    extended,
    hasRgb,
    hasGpsTime,
    classificationOffset: extended ? RECORD_CLASSIFICATION_EXT : RECORD_CLASSIFICATION_LEGACY,
    pointSourceOffset: extended ? RECORD_POINT_SOURCE_EXT : RECORD_POINT_SOURCE_LEGACY,
    gpsTimeOffset,
    rgbOffset,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public decode entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode one EPT laszip tile into a `DecodedChunk`. Tile is the complete
 * LAZ file bytes (LAS public header + LAZ stream); render origin is the
 * EPT cloud's per-cloud Float64 shift.
 *
 * Throws:
 *   • If the buffer isn't a LASF-signed file.
 *   • If the LAS point data record format isn't one of {0, 1, 2, 3, 6, 7, 8}.
 *   • If the laz-perf WASM fails to instantiate (network / sandbox issue).
 *
 * Resolves with a `DecodedChunk` shaped exactly like the COPC pipeline
 * produces, so the renderer + scheduler treat EPT laszip tiles and
 * COPC nodes identically downstream.
 */
export async function decodeEptLaszipTile(
  buffer: ArrayBuffer,
  renderOrigin: readonly [number, number, number],
): Promise<DecodedChunk> {
  const ctx = buildContext(buffer);
  const n = ctx.pointCount;
  const lazPerf = await getLazPerf();
  const fileBytes = new Uint8Array(buffer);

  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  const gpsTime = new Float64Array(n);  // always allocated (cheap) — see DecodedChunk
  let rgb: Uint8Array | undefined;
  if (ctx.hasRgb) rgb = new Uint8Array(n * 3);

  const [rx, ry, rz] = renderOrigin;
  const filePtr = lazPerf._malloc(fileBytes.byteLength);
  const reader = new lazPerf.LASZip();
  let pointPtr = 0;

  try {
    lazPerf.HEAPU8.set(fileBytes, filePtr);
    reader.open(filePtr, fileBytes.byteLength);
    pointPtr = lazPerf._malloc(reader.getPointLength());
    let heap = new DataView(lazPerf.HEAPU8.buffer);

    for (let i = 0; i < n; i++) {
      reader.getPoint(pointPtr);
      // laz-perf can grow its heap mid-decode; refresh the view if so.
      if (heap.buffer !== lazPerf.HEAPU8.buffer) {
        heap = new DataView(lazPerf.HEAPU8.buffer);
      }
      const xi = heap.getInt32(pointPtr, true);
      const yi = heap.getInt32(pointPtr + 4, true);
      const zi = heap.getInt32(pointPtr + 8, true);
      // Float64 arithmetic end-to-end; the Float32 narrow happens only
      // on the typed-array assignment.
      positions[i * 3]     = xi * ctx.scale[0] + ctx.offset[0] - rx;
      positions[i * 3 + 1] = yi * ctx.scale[1] + ctx.offset[1] - ry;
      positions[i * 3 + 2] = zi * ctx.scale[2] + ctx.offset[2] - rz;

      intensity[i] = heap.getUint16(pointPtr + RECORD_INTENSITY, true);

      // Return bits + classification. Extended layout uses different
      // byte offsets and widens both fields to 4 bits.
      const returnBits = heap.getUint8(pointPtr + (ctx.extended ? RECORD_RETURN_BITS_EXT : RECORD_RETURN_BITS_LEGACY));
      if (ctx.extended) {
        returnNumber[i] = returnBits & 0x0f;
        returnCount[i] = (returnBits >> 4) & 0x0f;
      } else {
        returnNumber[i] = returnBits & 0x07;
        returnCount[i] = (returnBits >> 3) & 0x07;
      }
      classification[i] = heap.getUint8(pointPtr + ctx.classificationOffset)
        & (ctx.extended ? 0xff : 0x1f);

      pointSourceId[i] = heap.getUint16(pointPtr + ctx.pointSourceOffset, true);

      if (ctx.gpsTimeOffset !== null) {
        gpsTime[i] = heap.getFloat64(pointPtr + ctx.gpsTimeOffset, true);
      }

      if (rgb && ctx.rgbOffset !== null) {
        // LAS RGB is uint16 0-65535; narrow to uint8 0-255 with >> 8.
        const r = heap.getUint16(pointPtr + ctx.rgbOffset, true);
        const g = heap.getUint16(pointPtr + ctx.rgbOffset + 2, true);
        const b = heap.getUint16(pointPtr + ctx.rgbOffset + 4, true);
        rgb[i * 3]     = r >> 8;
        rgb[i * 3 + 1] = g >> 8;
        rgb[i * 3 + 2] = b >> 8;
      }
    }
  } finally {
    reader.delete();
    if (pointPtr) lazPerf._free(pointPtr);
    lazPerf._free(filePtr);
  }

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
  };
}
