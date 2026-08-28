/**
 * tileRecord.ts — the fixed-length per-point record an out-of-core tile stores.
 *
 * The indexer buckets points into leaf tiles; each point is written as one
 * record of a fixed byte length so a tile is a flat, randomly-addressable array
 * the streaming reader can slice without parsing. The layout carries everything
 * the renderer needs in the source-local frame the rest of the loader already
 * uses: position, intensity, classification, return numbers, point-source id,
 * and, when the source has them, GPS time and RGB.
 *
 * The two optional fields are decided ONCE per file by {@link tileSchemaOf} (from
 * whether the decoded points carry them), never per point, so every record in a
 * store has the same length and the same offsets. Pure, unit-tested in Node.
 */
import { pointFormatHasRgb } from '../lasHeader';
import type { DecodeContext, RawPoints } from '../lasDecodeShared';

/** Which optional fields a file's records carry. Fixed for the whole file. */
export interface TileSchema {
  readonly hasGps: boolean;
  readonly hasRgb: boolean;
}

// Fixed base layout (bytes): xyz f32 ×3, intensity u16, classification u8,
// returnNumber u8, returnCount u8, pointSourceId u16 = 19; then gps f64, rgb u8×3.
const OFF_X = 0;
const OFF_Y = 4;
const OFF_Z = 8;
const OFF_INTENSITY = 12;
const OFF_CLASS = 14;
const OFF_RETURN_NUMBER = 15;
const OFF_RETURN_COUNT = 16;
const OFF_POINT_SOURCE = 17;
const BASE_BYTES = 19;
const GPS_BYTES = 8;
const RGB_BYTES = 3;

/** Bytes per record for a schema. */
export function tileRecordBytes(schema: TileSchema): number {
  return BASE_BYTES + (schema.hasGps ? GPS_BYTES : 0) + (schema.hasRgb ? RGB_BYTES : 0);
}

/** The schema of a decoded batch: what optional fields its points actually carry. */
export function tileSchemaOf(raw: RawPoints): TileSchema {
  return { hasGps: raw.gpsTime !== null, hasRgb: raw.colors !== null };
}

/** The schema a LAS point format implies, before any point is decoded. */
export function tileSchemaForHeader(pointFormat: number, ctx: DecodeContext): TileSchema {
  return { hasGps: ctx.gpsTimeOffset !== null, hasRgb: pointFormatHasRgb(pointFormat) };
}

/** Write point `i` of `raw` as one record at `offset` in `view`. */
export function packTileRecord(
  raw: RawPoints,
  i: number,
  schema: TileSchema,
  view: DataView,
  offset: number,
): void {
  view.setFloat32(offset + OFF_X, raw.positions[i * 3], true);
  view.setFloat32(offset + OFF_Y, raw.positions[i * 3 + 1], true);
  view.setFloat32(offset + OFF_Z, raw.positions[i * 3 + 2], true);
  view.setUint16(offset + OFF_INTENSITY, raw.intensity[i], true);
  view.setUint8(offset + OFF_CLASS, raw.classification[i]);
  view.setUint8(offset + OFF_RETURN_NUMBER, raw.returnNumber[i]);
  view.setUint8(offset + OFF_RETURN_COUNT, raw.returnCount[i]);
  view.setUint16(offset + OFF_POINT_SOURCE, raw.pointSourceId[i], true);
  let o = offset + BASE_BYTES;
  if (schema.hasGps) {
    view.setFloat64(o, raw.gpsTime ? raw.gpsTime[i] : 0, true);
    o += GPS_BYTES;
  }
  if (schema.hasRgb && raw.colors) {
    view.setUint8(o, raw.colors[i * 3]);
    view.setUint8(o + 1, raw.colors[i * 3 + 1]);
    view.setUint8(o + 2, raw.colors[i * 3 + 2]);
  }
}

/** One point read back from a tile record. Position is source-local, like RawPoints. */
export interface TilePoint {
  readonly position: [number, number, number];
  readonly intensity: number;
  readonly classification: number;
  readonly returnNumber: number;
  readonly returnCount: number;
  readonly pointSourceId: number;
  readonly gpsTime: number | null;
  readonly rgb: [number, number, number] | null;
}

/**
 * A whole tile decoded into parallel typed arrays — the render-ready shape, with
 * no per-point object allocated. GPS time is always present (zero-filled when the
 * schema has none) so a consumer needs no branch; `rgb` is null without colour.
 */
export interface DecodedTile {
  readonly pointCount: number;
  readonly positions: Float32Array;
  readonly intensity: Uint16Array;
  readonly classification: Uint8Array;
  readonly returnNumber: Uint8Array;
  readonly returnCount: Uint8Array;
  readonly gpsTime: Float64Array;
  readonly pointSourceId: Uint16Array;
  readonly rgb: Uint8Array | null;
}

/** A tile whose byte length does not match the point count the hierarchy declares. */
export class TileTruncationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileTruncationError';
  }
}

/**
 * Decode a tile's records straight into typed arrays. Fields are read inline
 * from the byte view — no {@link TilePoint} per point — so a full leaf decodes
 * without a million short-lived objects.
 *
 * When `expectedPointCount` is given (the exact count the store hierarchy records
 * for this tile), the tile's byte length MUST equal `expectedPointCount *
 * recordBytes`. A truncated or over-long tile is a corrupt store, not a smaller
 * valid one, so it throws {@link TileTruncationError} rather than silently
 * decoding whatever whole records happen to be present — which would present a
 * corrupt tile as a sparse one. With no `expectedPointCount` (the loose reader
 * path) every whole record present is decoded.
 */
export function decodeTile(
  bytes: Uint8Array,
  schema: TileSchema,
  recordBytes: number,
  expectedPointCount?: number,
): DecodedTile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const available = recordBytes > 0 ? Math.floor(bytes.byteLength / recordBytes) : 0;
  let n: number;
  if (expectedPointCount === undefined) {
    n = Math.max(0, available);
  } else {
    if (!Number.isSafeInteger(expectedPointCount) || expectedPointCount < 0) {
      throw new TileTruncationError(
        `tileRecord: expected point count ${expectedPointCount} is not a valid count`,
      );
    }
    const need = expectedPointCount * recordBytes;
    if (bytes.byteLength !== need) {
      throw new TileTruncationError(
        `tileRecord: tile is ${bytes.byteLength} bytes but the hierarchy declares ` +
          `${expectedPointCount} points × ${recordBytes} bytes = ${need}; the store is truncated or corrupt`,
      );
    }
    n = expectedPointCount;
  }
  const positions = new Float32Array(n * 3);
  const intensity = new Uint16Array(n);
  const classification = new Uint8Array(n);
  const returnNumber = new Uint8Array(n);
  const returnCount = new Uint8Array(n);
  const gpsTime = new Float64Array(n);
  const pointSourceId = new Uint16Array(n);
  const rgb = schema.hasRgb ? new Uint8Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    const o = i * recordBytes;
    positions[i * 3] = view.getFloat32(o + OFF_X, true);
    positions[i * 3 + 1] = view.getFloat32(o + OFF_Y, true);
    positions[i * 3 + 2] = view.getFloat32(o + OFF_Z, true);
    intensity[i] = view.getUint16(o + OFF_INTENSITY, true);
    classification[i] = view.getUint8(o + OFF_CLASS);
    returnNumber[i] = view.getUint8(o + OFF_RETURN_NUMBER);
    returnCount[i] = view.getUint8(o + OFF_RETURN_COUNT);
    pointSourceId[i] = view.getUint16(o + OFF_POINT_SOURCE, true);
    let p = o + BASE_BYTES;
    if (schema.hasGps) {
      gpsTime[i] = view.getFloat64(p, true);
      p += GPS_BYTES;
    }
    if (rgb) {
      rgb[i * 3] = view.getUint8(p);
      rgb[i * 3 + 1] = view.getUint8(p + 1);
      rgb[i * 3 + 2] = view.getUint8(p + 2);
    }
  }
  return { pointCount: n, positions, intensity, classification, returnNumber, returnCount, gpsTime, pointSourceId, rgb };
}

/** Read one record at `offset` back into a point. */
export function readTileRecord(view: DataView, offset: number, schema: TileSchema): TilePoint {
  const position: [number, number, number] = [
    view.getFloat32(offset + OFF_X, true),
    view.getFloat32(offset + OFF_Y, true),
    view.getFloat32(offset + OFF_Z, true),
  ];
  let o = offset + BASE_BYTES;
  let gpsTime: number | null = null;
  if (schema.hasGps) {
    gpsTime = view.getFloat64(o, true);
    o += GPS_BYTES;
  }
  let rgb: [number, number, number] | null = null;
  if (schema.hasRgb) {
    rgb = [view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2)];
  }
  return {
    position,
    intensity: view.getUint16(offset + OFF_INTENSITY, true),
    classification: view.getUint8(offset + OFF_CLASS),
    returnNumber: view.getUint8(offset + OFF_RETURN_NUMBER),
    returnCount: view.getUint8(offset + OFF_RETURN_COUNT),
    pointSourceId: view.getUint16(offset + OFF_POINT_SOURCE, true),
    gpsTime,
    rgb,
  };
}
