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
 * **Threading note:** the decode loop is CPU-bound (laz-perf decompress +
 * the per-record coordinate transform). It is split into a sync core
 * (`decodeEptLaszipTileWith`, which takes an already-instantiated laz-perf
 * module) and the async `decodeEptLaszipTile` wrapper that acquires the
 * cached module. The dedicated EPT laszip worker
 * (`worker/eptLaszipWorker.ts`) runs the sync core off the main thread; the
 * in-process `decodeEptLaszipTile` is the fallback the binary path and the
 * Node tests use. Both share this one decode core, so there is a single
 * source of truth for the LAS record layout.
 *
 * **Supported point formats:** PDRF 0-3 (legacy, no GPS time / GPS time)
 * and PDRF 6-8 (extended). Other formats throw a typed error so the
 * Studio gates surface a clear message instead of producing garbage.
 * PDRF 0 and 2 have no GPS field, so a tile in either leaves the chunk's
 * `gpsTime` absent rather than reporting a time of zero at every point.
 *
 * Pure of three.js. Async only through the laz-perf WASM initialisation
 * promise (cached after the first call across the entire session).
 */

import { parseLasHeader } from '../lasHeader';
import { getLazPerf } from '../loadLas';
import {
  validateDeclaredPointCount,
  compressedBytesPerPointFloor,
} from '../validateCount';
import {
  HeavyByteBudgetError,
  MAX_DECODE_PEAK_BYTES,
  withinDecodePeakBudget,
} from '../heavy/heavyByteBudget';
import { assertFiniteNodeTransform, assertFinitePositions } from '../streamingFiniteGuard';
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

/**
 * Peak decoded bytes ONE point of this tile stages at once, across every output
 * channel the decode allocates for the tile's format plus the raw-RGB staging
 * buffer that coexists with the narrowed one. Structural channels are always
 * present; GPS time and the two RGB buffers are gated exactly as the allocations
 * below them are, so the estimate tracks the real transient peak rather than a
 * worst-case guess.
 *
 *   positions   Float32 × 3   12
 *   intensity   Uint16         2
 *   class       Uint8          1
 *   returnNo    Uint8          1
 *   returnCnt   Uint8          1
 *   sourceId    Uint16         2   ── structural subtotal 19
 *   gpsTime     Float64        8   (PDRF 1/3/6-8 only)
 *   rgb         Uint8 × 3      3   (RGB formats only)
 *   rgb16       Uint16 × 3     6   (RGB staging, freed after narrowing)
 */
const EPT_STRUCTURAL_BYTES_PER_POINT = 19;
function decodedBytesPerPoint(ctx: TileDecodeContext): number {
  return (
    EPT_STRUCTURAL_BYTES_PER_POINT +
    (ctx.gpsTimeOffset !== null ? 8 : 0) +
    (ctx.hasRgb ? 3 + 6 : 0)
  );
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
 *   • If the per-tile header declares more points than the tile bytes
 *     could plausibly hold (typed malformed-file LoadError — blocks a
 *     hostile remote tile from forcing a giant allocation below).
 *   • If the laz-perf WASM fails to instantiate (network / sandbox issue).
 *
 * Resolves with a `DecodedChunk` shaped exactly like the COPC pipeline
 * produces, so the renderer + scheduler treat EPT laszip tiles and
 * COPC nodes identically downstream.
 */
export async function decodeEptLaszipTile(
  buffer: ArrayBuffer,
  renderOrigin: readonly [number, number, number],
  rgbEightBit?: boolean,
): Promise<DecodedChunk> {
  const lazPerf = await getLazPerf();
  return decodeEptLaszipTileWith(lazPerf, buffer, renderOrigin, rgbEightBit);
}

/** The instantiated laz-perf WASM module (type-only — no runtime import). */
type LazPerfModule = Awaited<ReturnType<typeof import('laz-perf').createLazPerf>>;

/**
 * Synchronous decode core: identical work to {@link decodeEptLaszipTile}, but
 * takes an already-instantiated laz-perf module instead of acquiring one. This
 * is the single source of truth for the per-tile decode — the in-process
 * wrapper above and the dedicated EPT laszip worker both call it, so the LAS
 * record layout lives in exactly one place. Pure of three.js and of any
 * module-acquisition I/O, so it runs unchanged on the main thread or inside a
 * `DedicatedWorkerGlobalScope`.
 *
 * `rgbEightBit` is the DATASET-level RGB bit-depth decision, when one has
 * already been pinned from the first decoded RGB tile (via the
 * `ChunkDecodeMetadata.rgbEightBit` seam the COPC pipeline uses). Undefined
 * on the first tile — this decode then decides from its own max channel
 * value and reports the decision back on the returned chunk.
 */
export function decodeEptLaszipTileWith(
  lazPerf: LazPerfModule,
  buffer: ArrayBuffer,
  renderOrigin: readonly [number, number, number],
  rgbEightBit?: boolean,
): DecodedChunk {
  const ctx = buildContext(buffer);
  // Bound the per-tile declared count by the tile's own bytes BEFORE the
  // seven typed-array allocations below. EPT tiles arrive from remote
  // URLs, and the floor comes from the record length, so this only trips
  // on a header lying by orders of magnitude.
  const n = validateDeclaredPointCount(
    ctx.pointCount,
    buffer.byteLength,
    compressedBytesPerPointFloor(ctx.recordLength),
    'EPT laszip tile',
  );
  // The count guard above only bounds the declared count by the tile's own
  // compressed bytes, and at the loose LAZ ratio floor a large-but-honest tile
  // can still pass with a point count whose decoded channels — positions,
  // intensity, classification, returns, source id, GPS time, and both RGB
  // buffers — stage far more transient memory than the compressed payload. Bound
  // the SUMMED peak (compressed span held in the WASM heap + every decoded
  // channel) against the shared heavy-path ceiling BEFORE the seven typed-array
  // allocations below, so an over-budget tile is refused rather than allocated.
  if (
    !withinDecodePeakBudget(
      buffer.byteLength,
      n,
      decodedBytesPerPoint(ctx),
      0,
      MAX_DECODE_PEAK_BYTES,
    )
  ) {
    throw new HeavyByteBudgetError(
      `EPT laszip tile: ${n.toLocaleString('en-US')} points would stage ` +
        `${(n * decodedBytesPerPoint(ctx)).toLocaleString('en-US')} decoded bytes ` +
        `plus a ${buffer.byteLength.toLocaleString('en-US')}-byte compressed payload, ` +
        `over the ${MAX_DECODE_PEAK_BYTES.toLocaleString('en-US')}-byte decode budget.`,
    );
  }
  // Fail before decoding a whole tile when its transform is outright non-finite
  // (a bad scale/offset in the header, or a non-finite render origin). Cheap and
  // O(1); it does NOT catch a finite-but-extreme scale overflowing
  // `int32 · scale + offset`, so the finished positions are scanned below.
  // The COPC and EPT-binary decoders refuse such a node the same way — this one
  // drew it, sending Infinity to three.js with no structured error.
  assertFiniteNodeTransform(ctx.scale, ctx.offset, renderOrigin);
  const fileBytes = new Uint8Array(buffer);

  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const pointSourceId = new Uint16Array(n);
  // GPS time is the one measured channel a supported LAS record can genuinely
  // lack: PDRF 0 and 2 carry no GPS field, which is what a null `gpsTimeOffset`
  // means. Allocating regardless gave every point of such a tile a GPS time of
  // exactly zero — a reading the file never took. Gated on the same offset the
  // loop reads from, so the two cannot drift apart. Intensity, the return bits,
  // classification and point source id are structural in every record of every
  // supported format (PDRF 0-3, 6-8), so they stay unconditional.
  const gpsTime = ctx.gpsTimeOffset !== null ? new Float64Array(n) : undefined;
  let rgb: Uint8Array | undefined;
  if (ctx.hasRgb) rgb = new Uint8Array(n * 3);
  // Stage raw 16-bit colour so the 8-bit-in-low-byte vs true-16-bit narrowing
  // is decided ONCE per dataset (pinned `rgbEightBit`, else this tile's max),
  // never per record — see the parameter doc above. Mirrors
  // `lasDecodeShared.finalizeRawColors` / the COPC `rgbEightBit` seam.
  const rgb16 = ctx.hasRgb ? new Uint16Array(n * 3) : undefined;
  let maxRgb = 0;

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

      if (gpsTime && ctx.gpsTimeOffset !== null) {
        gpsTime[i] = heap.getFloat64(pointPtr + ctx.gpsTimeOffset, true);
      }

      if (rgb16 && ctx.rgbOffset !== null) {
        // LAS RGB is nominally uint16 0-65535, but some writers stuff 8-bit
        // values into the low byte; stage raw and narrow after the loop.
        const r = heap.getUint16(pointPtr + ctx.rgbOffset, true);
        const g = heap.getUint16(pointPtr + ctx.rgbOffset + 2, true);
        const b = heap.getUint16(pointPtr + ctx.rgbOffset + 4, true);
        rgb16[i * 3]     = r;
        rgb16[i * 3 + 1] = g;
        rgb16[i * 3 + 2] = b;
        if (r > maxRgb) maxRgb = r;
        if (g > maxRgb) maxRgb = g;
        if (b > maxRgb) maxRgb = b;
      }
    }
  } finally {
    reader.delete();
    if (pointPtr) lazPerf._free(pointPtr);
    lazPerf._free(filePtr);
  }

  // Single dataset-level narrowing decision: the pinned value when the source
  // provided one, else this tile's own max (≤ 255 ⇒ 8-bit-in-low-byte).
  let usedEightBit: boolean | undefined;
  if (rgb && rgb16) {
    usedEightBit = rgbEightBit ?? (maxRgb <= 255);
    for (let i = 0; i < rgb16.length; i++) {
      rgb[i] = usedEightBit ? rgb16[i] & 0xff : rgb16[i] >> 8;
    }
  }

  // Backstop the up-front transform check: a finite-but-extreme scale/offset can
  // still overflow a coordinate to ±Infinity, so refuse the tile if any did.
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
    rgbEightBit: usedEightBit,
  };
}
