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
