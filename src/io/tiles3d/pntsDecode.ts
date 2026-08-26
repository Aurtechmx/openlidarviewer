/**
 * pntsDecode.ts — decode a `.pnts` tile body into the streaming pipeline's
 * chunk shape.
 *
 * The streaming scheduler is format-neutral about decoding: it obtains an
 * opaque metadata object from the source and hands it, with the tile bytes, to
 * an injected {@link ChunkDecoder}. COPC and EPT both hand it LAS chunk
 * metadata. A `.pnts` body carries none of that, so this module supplies its
 * own metadata shape and its own decoder.
 *
 * WHAT A PNTS TILE DOES NOT CARRY, and why the chunk still has those fields:
 * `DecodedChunk` was written for LAS-derived data and requires intensity,
 * classification, return number, return count and GPS time. A point tile has
 * none of them. They are filled with zeros here because the type requires an
 * array of the right length, NOT because a zero is a reading: zero
 * classification is "never classified" and zero intensity is not a measured
 * zero. A source backed by these tiles therefore advertises only the colour
 * modes the format actually carries, so nothing offers to paint a scan by a
 * channel that holds no information. `tests/pntsDecode.test.ts` pins that.
 *
 * Positions arrive tile-local. The tile's own `RTC_CENTER`, then its cumulative
 * placement down the tileset tree, then the render origin are applied in
 * float64 before the float32 store, which is the same order the LAS path uses
 * and the reason a city-scale tileset does not lose precision at the far edge.
 *
 * Pure: no fetch, no DOM.
 */

import { parsePnts } from './pnts';
import type { ChunkDecoder, DecodedChunk } from '../copc/copcChunkDecode';

/**
 * Metadata for decoding one `.pnts` body.
 *
 * `format` discriminates this from LAS chunk metadata at the decoder seam.
 * LAS metadata carries no `format` field, so a decoder narrows with an `in`
 * check and no existing metadata site had to change.
 */
export interface PntsDecodeMetadata {
  readonly format: 'pnts';
  /**
   * Column-major 4x4 placing this tile in the tileset root frame: the product
   * of every `transform` from the root down to this tile.
   */
  readonly tileTransform: readonly number[];
  /** Render origin, subtracted in float64 before the float32 store. */
  readonly renderOrigin: readonly [number, number, number];
}

/** Whether a decoder was handed point-tile metadata rather than LAS metadata. */
export function isPntsMetadata(meta: unknown): meta is PntsDecodeMetadata {
  return typeof meta === 'object' && meta !== null && (meta as { format?: unknown }).format === 'pnts';
}

/** Apply a column-major 4x4 to (x, y, z), in float64. */
function applyMatrix(
  m: readonly number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/**
 * Decode a `.pnts` body into a chunk the streaming renderer can store.
 *
 * Throws when handed metadata for another format rather than guessing, since a
 * mis-routed body would decode into plausible-looking rubbish.
 */
export class PntsChunkDecoder implements ChunkDecoder {
  async decode(chunk: ArrayBuffer, meta: unknown): Promise<DecodedChunk> {
    if (!isPntsMetadata(meta)) {
      throw new Error('PntsChunkDecoder was handed metadata for another format.');
    }
    const tile = parsePnts(chunk);
    const n = tile.pointsLength;
    const positions = new Float32Array(n * 3);
    const [ox, oy, oz] = meta.renderOrigin;
    const rtc = tile.rtcCenter ?? [0, 0, 0];
    // Hoisted: the tile's own local array, read once rather than three times
    // per point. Its frame is the tile's local space, before RTC_CENTER.
    const local = tile.positions;

    for (let i = 0; i < n; i++) {
      const j = i * 3;
      // RTC_CENTER first: the tile stores positions relative to it, and the
      // transform places the tile, not the offset.
      const [wx, wy, wz] = applyMatrix(
        meta.tileTransform,
        local[j] + rtc[0],
        local[j + 1] + rtc[1],
        local[j + 2] + rtc[2],
      );
      positions[j] = wx - ox;
      positions[j + 1] = wy - oy;
      positions[j + 2] = wz - oz;
    }

    return {
      pointCount: n,
      positions,
      // Not readings. See the note at the top of this file: the chunk type
      // requires these arrays, and a point tile carries none of them.
      intensity: new Uint16Array(n),
      classification: new Uint8Array(n),
      returnNumber: new Uint8Array(n),
      returnCount: new Uint8Array(n),
      gpsTime: new Float64Array(n),
      ...(tile.colors ? { rgb: tile.colors } : {}),
    };
  }
}

/**
 * The colour modes a point tile can honestly drive.
 *
 * Intensity and classification are absent from the format, so they are absent
 * here. Elevation is derived from position and is always available. Normals
 * appear only when the tile carried them, which varies per tile, so a source
 * decides that from what it read rather than from the format alone.
 */
export const PNTS_COLOR_MODES = ['rgb', 'elevation'] as const;
