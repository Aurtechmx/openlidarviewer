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
 * WHAT A PNTS TILE DOES NOT CARRY, and what the chunk therefore omits:
 * intensity, classification, return number, return count and GPS time. A point
 * tile has none of them, and `DecodedChunk` makes every measured channel
 * optional, so this decoder allocates nothing for them. A zero is not a
 * reading: zero classification is "never classified" and zero intensity is not
 * a measured zero, so an absent channel and a zero-filled one must stay
 * distinguishable. A source backed by these tiles also advertises only the
 * colour modes the format actually carries, so nothing offers to paint a scan
 * by a channel that holds no information. `tests/pntsDecode.test.ts` pins both.
 *
 * WHAT IT CAN CARRY, beyond position and colour: surface normals, from either a
 * float32 `NORMAL` or an oct-encoded `NORMAL_OCT16P` accessor. `parsePnts` has
 * always read them; they now cross into the chunk, so the normals shading path,
 * the point inspector and the resident-snapshot export reach a streamed tileset
 * the same way they reach a static cloud.
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

/** What one decoded tile said about surface normals. */
export type TileNormalsState = 'normals' | 'no-normals';

/**
 * One layer's answer about one channel, folded from the tiles decoded so far.
 *
 * Colour and normals both need it and must not drift apart, so the rule is
 * written once and read at two states. See {@link TilesetColourConsensus} for
 * why `settled` is fixed by the first tile with points.
 */
interface ChannelConsensus<S extends string> {
  readonly settled: S | null;
  readonly disagreeing: number;
}

/**
 * Fold one decoded tile into a layer's consensus about one channel. Pure.
 *
 * An empty tile leaves the consensus alone: it states nothing either way, and
 * letting one settle the meaning would hand every tile after it a decision made
 * from no points.
 */
function noteTileChannel<S extends string>(
  state: ChannelConsensus<S>,
  pointCount: number,
  seen: S,
): ChannelConsensus<S> {
  if (pointCount <= 0) return state;
  if (state.settled === null) return { settled: seen, disagreeing: 0 };
  if (state.settled === seen) return state;
  return { settled: state.settled, disagreeing: state.disagreeing + 1 };
}

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
  return noteTileChannel(state, tile.pointCount, tile.hasColour ? 'colour' : 'no-colour');
}

/**
 * One tileset layer's answer about surface normals, folded the same way its
 * colour meaning is: the first tile with points settles it and it never moves.
 *
 * Normals vary per tile exactly as colour does, and the same two failures
 * follow from letting a layer hold both answers at once. Half a layer painted
 * by measured direction and half by an elevation ramp is two meanings under one
 * legend; half a layer carrying normals into the inspector, the profile section
 * and the resident-snapshot export, from a layer that states it has none, is a
 * measurement that appears for some points and not others with nothing saying
 * which is which.
 */
export interface TilesetNormalsConsensus {
  /** The layer's one answer, or null before any tile with points. */
  readonly settled: TileNormalsState | null;
  /** How many tiles disagreed with it. */
  readonly disagreeing: number;
}

/** No tile decoded yet, so the layer's normals answer is not established. */
export const NO_TILE_DECODED_NORMALS: TilesetNormalsConsensus = {
  settled: null,
  disagreeing: 0,
};

/** Fold one decoded tile into a layer's normals consensus. Pure. */
export function noteTileNormals(
  state: TilesetNormalsConsensus,
  tile: { readonly pointCount: number; readonly hasNormals: boolean },
): TilesetNormalsConsensus {
  return noteTileChannel(state, tile.pointCount, tile.hasNormals ? 'normals' : 'no-normals');
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
 * What a user is told when the layer carries surface normals and some tiles
 * state none. Those tiles keep no normals and are drawn flat under the Normal
 * mode, so the absence is visible rather than filled in with a direction.
 */
export const MIXED_TILE_NORMALS_KEPT_NOTICE =
  'Some tiles in this tileset carry surface normals and others do not. The ' +
  'tiles that state none are drawn flat grey under Normal colouring, and no ' +
  'direction is reported for their points.';

/**
 * What a user is told when the layer's first tile stated no normals and a later
 * one does. Those normals are withheld, so the layer holds one answer: the
 * Normal colour mode is not offered, and no part of the scan reports a
 * direction the rest of it cannot.
 */
export const MIXED_TILE_NORMALS_DROPPED_NOTICE =
  'Some tiles in this tileset carry surface normals and others do not. The ' +
  'layer states none, so no tile normals are used and Normal colouring is not ' +
  'offered for this scan.';

/** The normals notice for a mixed tileset, or null while every tile has agreed. */
export function tilesetNormalsNotice(state: TilesetNormalsConsensus): string | null {
  if (state.disagreeing === 0) return null;
  return state.settled === 'normals'
    ? MIXED_TILE_NORMALS_KEPT_NOTICE
    : MIXED_TILE_NORMALS_DROPPED_NOTICE;
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
  /**
   * Called once, with the notice text, the first time a tile disagrees with the
   * layer's settled answer about surface normals. Same contract as {@link
   * onColourNotice}: without it the layer still holds one answer, and nothing
   * says why a Normal chip is missing or a patch is drawn flat.
   */
  readonly onNormalsNotice?: (message: string) => void;
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
  private readonly _onNormalsNotice: ((message: string) => void) | undefined;
  private _colour: TilesetColourConsensus = NO_TILE_DECODED;
  private _normals: TilesetNormalsConsensus = NO_TILE_DECODED_NORMALS;
  private _noticed = false;
  private _normalsNoticed = false;

  constructor(options: PntsChunkDecoderOptions = {}) {
    this._onColourNotice = options.onColourNotice;
    this._onNormalsNotice = options.onNormalsNotice;
  }

  /** The layer's colour meaning as the tiles decoded so far have settled it. */
  get colourConsensus(): TilesetColourConsensus {
    return this._colour;
  }

  /** The mixed-tileset notice, or null while every tile has agreed. */
  get colourNotice(): string | null {
    return tilesetColourNotice(this._colour);
  }

  /** The layer's normals answer as the tiles decoded so far have settled it. */
  get normalsConsensus(): TilesetNormalsConsensus {
    return this._normals;
  }

  /** The mixed-normals notice, or null while every tile has agreed. */
  get normalsNotice(): string | null {
    return tilesetNormalsNotice(this._normals);
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

    // The layer's normals answer, settled the same way and for the same reason.
    // A tile that disagrees never has its normals re-interpreted: either the
    // layer carries them and this tile simply states none, or the layer states
    // none and this tile's normals are withheld.
    this._normals = noteTileNormals(this._normals, {
      pointCount: n,
      hasNormals: tile.normals !== null,
    });
    this._raiseNormalsNoticeOnce();

    // Intensity, classification, return number, return count and GPS time are
    // simply absent — see the note at the top of this file. Nothing is
    // allocated for them, so a reader is told the channel is missing rather
    // than handed `pointCount` zeros that look like readings.
    //
    // Normals are the one channel a point tile CAN state, so they are carried
    // through as the tile wrote them — never re-normalised, never invented for
    // a tile that has none.
    const decoded: DecodedChunk = {
      pointCount: n,
      positions,
      ...(this._normals.settled === 'normals' && tile.normals !== null
        ? { normals: tile.normals }
        : {}),
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

  /** Report a normals mixture the first time one appears, and only then. */
  private _raiseNormalsNoticeOnce(): void {
    if (this._normalsNoticed) return;
    const notice = tilesetNormalsNotice(this._normals);
    if (notice === null) return;
    this._normalsNoticed = true;
    this._onNormalsNotice?.(notice);
  }
}

/**
 * The colour modes a point tile can honestly drive.
 *
 * Intensity and classification are absent from the format, so they are absent
 * here. Elevation is derived from position and is always available.
 *
 * This is the format's CEILING, not any one layer's offer. Colour and normals
 * are stated per tile, so a source narrows this list to what its tiles have
 * actually stated: RGB leaves it for a tileset whose tiles carry none, and
 * `normal` joins it once a tile has stated normals. See
 * `TilesetStreamingSource.availableColorModes`.
 */
export const PNTS_COLOR_MODES = ['rgb', 'elevation'] as const;
