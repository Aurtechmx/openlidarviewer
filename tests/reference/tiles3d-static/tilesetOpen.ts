/**
 * SUPERSEDED REFERENCE. Not the code the product runs.
 *
 * The fetch/decode half of the one-shot tileset read in `tilesetCloud.ts`
 * beside it. A `tileset.json` now opens through `src/app/openTilesetLayer.ts`
 * into `src/render/streaming/TilesetStreamingSource.ts`, which reaches the same
 * parser, transport and URL guards directly and builds its node index with
 * `src/io/tiles3d/tilesetNodes.ts`. Nothing in `src/` imports this file.
 *
 * `MAX_SELECTED_TILES` below has no streaming equivalent: it capped the fetch
 * list ONE camera position produced, and the streaming path has no such list.
 * What bounds the streaming reader is `DEFAULT_TILESET_MAX_TILES` at parse plus
 * the scheduler's point-pressure budget.
 *
 * Do not import this from `src/`.
 */
/**
 * tilesetOpen.ts — opening a remote 3D Tiles tileset, selecting what a view
 * needs from it, and decoding the tiles that selection names.
 *
 * This is the resource layer the pure modules beside it were written to be
 * driven by. `tileset.ts` parses, `tileTransform.ts` places, `screenSpaceError.ts`
 * measures, `tilesetTraversal.ts` decides, `pnts.ts` decodes; none of them
 * fetch, and none of them knew about each other's caller. Three functions here
 * compose them into the open → select → read → decode sequence, and each keeps
 * its own refusal:
 *
 *   openTileset          fetch + parse + validate, or refuse
 *   selectTileContents   traverse, resolve URIs, cap the result
 *   fetchTileContent     read one `.pnts` and place it in root space
 *
 * WHAT IS BOUNDED, AND WHY EVERY NUMBER HERE IS ONE. A tileset declares its own
 * structure, so nothing it says may size an allocation on its own. The document
 * body is capped by the transport; the tile COUNT and the tree DEPTH are capped
 * at parse, because a small document can name a large tree; the SELECTION is
 * capped, because a legal shallow tileset with a very wide root would otherwise
 * hand the caller an unbounded list of fetches from one camera position. Each
 * cap refuses. None truncates, because a hierarchy silently pruned mid-traversal
 * renders as a plausible scene with geometry quietly missing, which is the
 * failure mode that is hardest to notice and worst to ship.
 *
 * WHAT IS NOT HERE. Nothing mounts. There is no `StreamingSource` implementation
 * in this module and no viewer wiring. That source was later written directly
 * against the parser and the node index instead, which is what left this file
 * with no caller.
 *
 * EXTERNAL TILESETS. A `content.uri` naming another `tileset.json` is reported,
 * not followed. Following one is a second recursion over remote input with its
 * own depth budget, and stubbing it as "fetch and splice" is how the tile-count
 * cap above would be escaped one document at a time.
 */

import { parseTileset, type Tileset, type TilesetParseLimits } from '../../../src/io/tiles3d/tileset';
import { selectTiles, type SelectedTile, type ViewCamera } from '../../../src/io/tiles3d/tilesetTraversal';
import { transformPoint } from '../../../src/io/tiles3d/tileTransform';
import { parsePnts } from '../../../src/io/tiles3d/pnts';
import {
  resolveTilesetContentUrl,
  tilesetBaseUrl,
  tilesetUrlSearch,
  validateRemoteTilesetUrl,
} from '../../../src/io/tiles3d/tilesetUrl';
import type { TilesetTransport } from '../../../src/io/tiles3d/tilesetTransport';

/**
 * Ceiling on how many tiles ONE view may select.
 *
 * The traversal's depth cap bounds how deep it descends but not how wide: a
 * legal tileset can put a hundred thousand children under a root with a large
 * geometric error, and a camera close to it refines into all of them. This is
 * the cap on the fetch list that comes out, and it is a refusal so a caller
 * never streams a quietly truncated view believing it is complete.
 */
export const MAX_SELECTED_TILES = 4096;

/** A tileset fetched, parsed and validated, with the URLs its content resolves against. */
export interface OpenedTileset {
  /** The entry URL, as it passed validation. */
  readonly entryUrl: string;
  /** The directory content URIs resolve against, always ending in `/`. */
  readonly baseUrl: string;
  /** The entry URL's query, re-attached to derived requests. */
  readonly search: string;
  readonly tileset: Tileset;
}

/** One tile a view selected, with its content resolved to a fetchable URL. */
export interface SelectedTileContent {
  readonly selected: SelectedTile;
  /** The validated absolute URL of this tile's content. */
  readonly url: string;
  /** `pnts` for a point tile; `tileset` for an external tileset, which is not followed. */
  readonly kind: 'pnts' | 'tileset';
}

/** What one selection produced, including what it deliberately did not fetch. */
export interface TileSelection {
  /** Tiles whose content is a `.pnts`, in traversal order. */
  readonly contents: readonly SelectedTileContent[];
  /**
   * External `tileset.json` contents the selection reached and did NOT follow.
   * Reported rather than dropped, so a caller can say that part of the scene is
   * missing instead of showing an incomplete one as if it were whole.
   */
  readonly externalTilesets: readonly SelectedTileContent[];
  /** Selected tiles that render but carry no content of their own. */
  readonly emptyTiles: number;
}

/** A `.pnts` tile decoded and placed into the tileset's root space. */
export interface PlacedTileContent {
  readonly url: string;
  readonly pointCount: number;
  /**
   * Root-space xyz triples, float64.
   *
   * Float64 because the placement is applied here: a PNTS tile's positions are
   * tile-local float32, and a 3D Tiles transform is routinely an ECEF placement
   * whose translation is millions of metres. Adding that to a float32 value
   * whose step is already coarser than the survey precision the file carries
   * destroys the precision before any consumer sees it, so the composition
   * happens in float64 and the downcast is left to whoever builds a buffer.
   */
  readonly positions: Float64Array;
  /** Interleaved sRGB bytes, or null when the tile carries no colour. */
  readonly colors: Uint8Array | null;
}

/**
 * Fetch, parse and validate a tileset entry document.
 *
 * Every refusal happens before anything is returned: a URL that fails the SSRF
 * and entrypoint gate is never fetched, a body past the transport ceiling is
 * never fully read, and a document whose tree exceeds the depth or tile budget
 * throws rather than yielding a partial tree. Nothing is ever half-opened.
 */
export async function openTileset(
  url: string,
  transport: TilesetTransport,
  signal?: AbortSignal,
  limits: TilesetParseLimits = {},
): Promise<OpenedTileset> {
  const check = validateRemoteTilesetUrl(url);
  if (!check.ok) throw new Error(`3D Tiles: ${check.reason}`);
  // Every request below uses the VALIDATED url, never the raw input.
  const entryUrl = check.url;
  const text = await transport.fetchTilesetJson(entryUrl, signal);
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('3D Tiles open aborted', 'AbortError');
  }
  // `parseTileset` throws on a malformed or over-budget document; it is not
  // caught here, because there is no partial tileset worth returning.
  const tileset = parseTileset(text, limits);
  return {
    entryUrl,
    baseUrl: tilesetBaseUrl(entryUrl),
    search: tilesetUrlSearch(entryUrl),
    tileset,
  };
}

/** How a content URI's filename classifies. Query and fragment are ignored. */
function contentKind(uri: string): 'pnts' | 'tileset' | 'other' {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith('.pnts')) return 'pnts';
  if (path.endsWith('.json')) return 'tileset';
  return 'other';
}

export interface SelectOptions {
  /** Refine while the screen-space error exceeds this, in pixels. */
  readonly maxScreenSpaceErrorPx: number;
  /** Stop descending past this depth. Defaults to the traversal's own cap. */
  readonly maxDepth?: number;
  /** Ceiling on the selection. Default {@link MAX_SELECTED_TILES}. */
  readonly maxSelectedTiles?: number;
}

/**
 * Select the tiles a view needs and resolve each one's content to a URL.
 *
 * The traversal is `selectTiles`, unchanged: transforms compose there, bounds
 * and screen-space error are measured there, and ADD-versus-REPLACE refinement
 * is decided there. This function adds the resource half — resolving each
 * selected tile's `content.uri` through the same-origin, same-directory gate,
 * and refusing a selection larger than the cap.
 *
 * A content URI that fails resolution throws. It is remote input naming a fetch
 * the guard refused, and skipping it would render most of a tileset that was
 * trying to direct the viewer somewhere it must not go.
 */
export function selectTileContents(
  opened: OpenedTileset,
  camera: ViewCamera,
  options: SelectOptions,
): TileSelection {
  const cap = options.maxSelectedTiles ?? MAX_SELECTED_TILES;
  const selected = selectTiles(opened.tileset, camera, {
    maxScreenSpaceErrorPx: options.maxScreenSpaceErrorPx,
    ...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
  });
  if (selected.length > cap) {
    throw new Error(
      `3D Tiles: this view selects ${selected.length} tiles, past the ${cap}-tile ceiling; refusing to fetch them.`,
    );
  }
  const contents: SelectedTileContent[] = [];
  const externalTilesets: SelectedTileContent[] = [];
  let emptyTiles = 0;
  for (const tile of selected) {
    const uri = tile.placed.tile.contentUri;
    if (uri === null) {
      emptyTiles++;
      continue;
    }
    const kind = contentKind(uri);
    if (kind === 'other') {
      // A tileset streamed here is a point-cloud tileset. A `.b3dm` or `.glb`
      // is a real 3D Tiles content type this viewer has no decoder for, and
      // fetching it to discover that wastes the transfer.
      throw new Error(`3D Tiles: content "${uri}" is not a .pnts tile or an external tileset.`);
    }
    const resolved = resolveTilesetContentUrl(opened.baseUrl, uri, opened.search);
    if (!resolved.ok) throw new Error(`3D Tiles: ${resolved.reason}`);
    const entry: SelectedTileContent = { selected: tile, url: resolved.url, kind };
    if (kind === 'pnts') contents.push(entry);
    else externalTilesets.push(entry);
  }
  return { contents, externalTilesets, emptyTiles };
}

/**
 * Fetch one selected `.pnts` and place its points in the tileset's root space.
 *
 * The decode is `parsePnts` — the same decoder a standalone `.pnts` opens
 * through, not a second one. The placement is the composition the standalone
 * path deliberately has no parent for: `RTC_CENTER` first, because it is stated
 * in the tile's own local frame, then the cumulative tile transform the
 * traversal carried down from the root.
 *
 * The order is the whole content of the function. Applying the transform before
 * `RTC_CENTER` rotates and scales a centre stated in the untransformed frame,
 * which leaves the tile somewhere plausible rather than somewhere wrong — and
 * the composition is column-major (`m[col * 4 + row]`, via `transformPoint`),
 * so a transposed read produces a scene that is subtly, consistently misplaced
 * rather than one that obviously fails.
 */
export async function fetchTileContent(
  content: SelectedTileContent,
  transport: TilesetTransport,
  signal?: AbortSignal,
): Promise<PlacedTileContent> {
  if (content.kind !== 'pnts') {
    throw new Error(`3D Tiles: ${content.url} is an external tileset, not a point tile.`);
  }
  const bytes = await transport.fetchTileBytes(content.url, signal);
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('3D Tiles tile read aborted', 'AbortError');
  }
  const tile = parsePnts(bytes);
  const [cx, cy, cz] = tile.rtcCenter ?? [0, 0, 0];
  const { positions: local } = tile;
  const matrix = content.selected.placed.transform;
  const out = new Float64Array(local.length);
  for (let i = 0; i < out.length; i += 3) {
    const [x, y, z] = transformPoint(matrix, [
      local[i]! + cx,
      local[i + 1]! + cy,
      local[i + 2]! + cz,
    ]);
    out[i] = x;
    out[i + 1] = y;
    out[i + 2] = z;
  }
  return {
    url: content.url,
    pointCount: tile.pointsLength,
    positions: out,
    colors: tile.colors,
  };
}
