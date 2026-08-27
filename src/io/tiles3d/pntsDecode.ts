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
 * ONE COLOUR MEANING PER LAYER. A point tile states colour per tile: some tiles
 * of a tileset can carry RGB while others carry none, and the document says
 * nothing about which. The reader that merged a whole tileset in one pass could
 * see every tile before it painted anything, and kept colour only when EVERY
 * tile carried it. A streaming reader sees one tile at a time, so that check
 * cannot be made up front. It is made here instead, by the decoder that serves
 * one layer: the first tile with points settles whether the layer's colour is
 * the colour tiles state or the elevation ramp, and every tile after it is
 * drawn in THAT meaning. A tile that disagrees is never re-interpreted into the
 * other meaning, and the mixture is reported through {@link
 * PntsChunkDecoderOptions.onColourNotice} rather than left for a viewer to
 * misread as one meaning.
 *
 * Nothing is fabricated to make that work. A tile with no colour keeps no
 * `rgb`, so the point inspector, the resident-snapshot export and the patch
 * view all keep reading "this states no colour"; only the on-screen colour
 * buffer is filled, and only flat.
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

/** What one decoded tile said about colour. */
export type TileColourState = 'colour' | 'no-colour';

/**
 * One tileset layer's colour meaning, folded from the tiles decoded so far.
 *
 * `settled` is what the first tile with points established, and it never
 * changes after that. That fixity is the guard, not an implementation detail:
 * nodes already uploaded to the scene cannot be repainted from here, so a
 * meaning that could change would leave the earlier nodes carrying the old one
 * beside nodes carrying the new one, which is the failure this exists to
 * prevent.
 */
export interface TilesetColourConsensus {
  /** The layer's one colour meaning, or null before any tile with points. */
  readonly settled: TileColourState | null;
  /** How many tiles disagreed with it. */
  readonly disagreeing: number;
}

/** No tile decoded yet, so the layer's colour meaning is not established. */
export const NO_TILE_DECODED: TilesetColourConsensus = { settled: null, disagreeing: 0 };

/**
 * Fold one decoded tile into a layer's colour consensus. Pure.
 *
 * An empty tile leaves the consensus alone. It states nothing about colour
 * either way, and letting one settle the meaning would hand every tile after it
 * a decision made from no points.
 */
export function noteTileColour(
  state: TilesetColourConsensus,
  tile: { readonly pointCount: number; readonly hasColour: boolean },
): TilesetColourConsensus {
  if (tile.pointCount <= 0) return state;
  const seen: TileColourState = tile.hasColour ? 'colour' : 'no-colour';
  if (state.settled === null) return { settled: seen, disagreeing: 0 };
  if (state.settled === seen) return state;
  return { settled: state.settled, disagreeing: state.disagreeing + 1 };
}

/**
 * What a user is told when the layer's colour is the colour tiles state and
 * some tiles state none. Those tiles are drawn flat, so the scene holds one
 * colour meaning plus a visibly blank stand-in for the tiles that have nothing
 * to show, rather than two meanings that look alike.
 */
export const MIXED_TILE_COLOUR_KEPT_NOTICE =
  'Some tiles in this tileset carry colour and others do not. The tiles that ' +
  'state no colour are drawn flat grey rather than ramped by height, so the ' +
  'scene keeps one colour meaning.';

/**
 * What a user is told when the layer's colour is the elevation ramp and some
 * tiles do carry colour. Their colour is withheld, which is the rule the merged
 * reader enforced when it could read every tile at once.
 */
export const MIXED_TILE_COLOUR_DROPPED_NOTICE =
  'Some tiles in this tileset carry colour and others do not. No tile colour ' +
  'is used and the whole layer is drawn by the elevation ramp, so the scene ' +
  'keeps one colour meaning.';

/** The notice for a mixed tileset, or null while every tile has agreed. */
export function tilesetColourNotice(state: TilesetColourConsensus): string | null {
  if (state.disagreeing === 0) return null;
  return state.settled === 'colour'
    ? MIXED_TILE_COLOUR_KEPT_NOTICE
    : MIXED_TILE_COLOUR_DROPPED_NOTICE;
}

/**
 * A decoded tile that states no colour, inside a layer whose colour meaning IS
 * the colour tiles state.
 *
 * `rgb` stays ABSENT: the mark is not a colour and never becomes one in the
 * data model. It exists so the renderer can draw the node flat instead of
 * ramping it by height beside neighbours painted from their own RGB, which is a
 * display decision and belongs nowhere else.
 */
export interface ColourUnstatedChunk extends DecodedChunk {
  readonly colourUnstated: true;
}

/** Construction options for {@link PntsChunkDecoder}. */
export interface PntsChunkDecoderOptions {
  /**
   * Called once, with the notice text, the first time a tile disagrees with the
   * layer's settled colour. The decoder owns no user surface, so the shell
   * passes one in; without it the layer still holds one colour meaning, and
   * nothing says why.
   */
  readonly onColourNotice?: (message: string) => void;
}

/**
 * Decode a `.pnts` body into a chunk the streaming renderer can store.
 *
 * One instance serves one tileset layer, which is what lets it hold that
 * layer's colour meaning across the tiles it decodes. Construct a fresh one per
 * layer.
 *
 * Throws when handed metadata for another format rather than guessing, since a
 * mis-routed body would decode into plausible-looking rubbish.
 */
export class PntsChunkDecoder implements ChunkDecoder {
  private readonly _onColourNotice: ((message: string) => void) | undefined;
  private _colour: TilesetColourConsensus = NO_TILE_DECODED;
  private _noticed = false;

  constructor(options: PntsChunkDecoderOptions = {}) {
    this._onColourNotice = options.onColourNotice;
  }

  /** The layer's colour meaning as the tiles decoded so far have settled it. */
  get colourConsensus(): TilesetColourConsensus {
    return this._colour;
  }

  /** The mixed-tileset notice, or null while every tile has agreed. */
  get colourNotice(): string | null {
    return tilesetColourNotice(this._colour);
  }

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

    // The layer's colour meaning, settled by the first tile with points and
    // fixed from then on. See the note at the top of this file.
    this._colour = noteTileColour(this._colour, {
      pointCount: n,
      hasColour: tile.colors !== null,
    });
    this._raiseColourNoticeOnce();

    const decoded: DecodedChunk = {
      pointCount: n,
      positions,
      // Not readings. See the note at the top of this file: the chunk type
      // requires these arrays, and a point tile carries none of them.
      intensity: new Uint16Array(n),
      classification: new Uint8Array(n),
      returnNumber: new Uint8Array(n),
      returnCount: new Uint8Array(n),
      gpsTime: new Float64Array(n),
    };
    if (this._colour.settled !== 'colour') {
      // The layer is drawn by the elevation ramp. A tile that does carry colour
      // has it withheld rather than painted beside ramped neighbours, because
      // half a scene in stated colour and half in a height ramp is two
      // meanings. Withholding states nothing false.
      return decoded;
    }
    if (tile.colors !== null) return { ...decoded, rgb: tile.colors };
    // Nothing to show and nothing invented: `rgb` stays absent, and the mark
    // only tells the renderer to draw this node flat.
    const unstated: ColourUnstatedChunk = { ...decoded, colourUnstated: true };
    return unstated;
  }

  /** Report the mixture the first time one appears, and only then. */
  private _raiseColourNoticeOnce(): void {
    if (this._noticed) return;
    const notice = tilesetColourNotice(this._colour);
    if (notice === null) return;
    this._noticed = true;
    this._onColourNotice?.(notice);
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
