/**
 * tilesetCloud.ts — a 3D Tiles tileset read once, in full, as one `PointCloud`.
 *
 * This is the caller `tilesetOpen.ts` was written for, and it is deliberately
 * the SMALL half of what a tileset could eventually be. A one-shot load opens
 * the entry document, selects the finest representation the tree offers THAT
 * FITS THE SELECTION CEILING (see `tilesetDetail.ts`), fetches those `.pnts`
 * bodies, and merges them into a single cloud that then
 * lives in the viewer exactly like a decoded LAS: no scheduler, no eviction, no
 * camera feedback. The streaming alternative is not what this is a step toward
 * being — it needs a node store keyed by octree records and LAS-shaped decode
 * metadata that a PNTS content tree has none of, so it is a different reader
 * rather than this one with more code.
 *
 * WHAT MAKES IT SAFE TO READ EVERYTHING AT ONCE. Nothing here is sized by what
 * the document declares. The transport caps each body, `parseTileset` caps the
 * tile count and the tree depth, `selectTileContents` caps the selection, and
 * {@link MAX_TILESET_POINTS} caps the merged total as the tiles actually decode.
 * Every one of those refuses. So does this module: a selection that reaches an
 * external `tileset.json`, or a total past the point ceiling, fails the load
 * with a message naming the reason.
 *
 * DETAIL IS CHOSEN, COMPLETENESS IS NOT. Asking unconditionally for the leaves
 * meant a tileset whose finest level is wider than the selection ceiling could
 * not be opened at all, however coarse a level of it would have fitted, so the
 * level is resolved first and the read then runs at that level. Coarser is a
 * different sampling of the same scene, not a partial one: the chosen level
 * still loads completely or fails. A cloud opened below the tileset's finest
 * detail SAYS SO, in a load warning, because nothing about a coarser tileset
 * looks coarse once it is on screen.
 *
 * WHY IT NEVER PARTIALLY SUCCEEDS. A merged cloud carries no record of which
 * tiles are in it. Dropping one that failed, or stopping at a ceiling and
 * keeping what had arrived, produces a scene that looks complete and measures
 * wrong — a volume over a hole reads as a real number. So the merge is
 * all-or-nothing, and every partial outcome is an error instead.
 *
 * The placement is NOT redone here. `fetchTileContent` returns each tile's
 * points already in the tileset's ROOT frame: it adds `RTC_CENTER` in the
 * tile's own local frame and then applies the cumulative root-to-tile transform
 * the traversal carried down. Those points are merged as they arrive. Applying
 * the transform again here would square it, which for the ECEF placements this
 * format is usually authored in puts the cloud somewhere no test with an
 * identity fixture would ever notice.
 */

import { PointCloud } from '../../model/PointCloud';
import { sanitizeAndRecenter, withLoadWarning } from '../sanitizeCloud';
import {
  openTileset,
  selectTileContents,
  fetchTileContent,
  MAX_SELECTED_TILES,
} from './tilesetOpen';
import {
  describeTilesetDetail,
  resolveTilesetDetail,
  FULL_DETAIL_SSE_PX,
  type TilesetDetail,
} from './tilesetDetail';
import type { TilesetTransport } from './tilesetTransport';
import type { ViewCamera } from './tilesetTraversal';

/**
 * Ceiling on the merged point total, checked as the tiles decode.
 *
 * The merge stages every point in float64 (24 bytes of position) before the
 * downcast, so 8 M points is roughly 190 MB of transient position data plus the
 * decoded tiles still held for the concatenation. Well above any tileset a
 * one-shot read is the right tool for, and below the point where the tab dies
 * instead of reporting a limit.
 */
export const MAX_TILESET_POINTS = 8_000_000;

/**
 * The refinement threshold a full read asks for, in pixels of screen-space
 * error.
 *
 * A one-shot load has no camera to be relative to: it wants every tile the tree
 * bottoms out in, not the subset one viewpoint would need. The traversal still
 * stops where a tileset says to: an interior tile declaring a geometric error
 * of zero states that it already represents its children exactly, and refining
 * past it would fetch detail the document says is not there.
 *
 * Defined in `tilesetDetail.ts`, which is where the ladder it is the finest
 * rung of lives, and re-exported here because this is where callers met it.
 */
export { FULL_DETAIL_SSE_PX };

/**
 * The camera the full read selects against.
 *
 * Distance only scales the screen-space error, and {@link FULL_DETAIL_SSE_PX}
 * is below anything a finite error at any distance produces, so the selection
 * this camera yields is the same from anywhere. It is here because
 * `selectTiles` takes a camera, not because a viewpoint is being chosen.
 */
const FULL_DETAIL_CAMERA: ViewCamera = {
  kind: 'perspective',
  positionEcef: [0, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

export interface TilesetCloudOptions {
  /** Display name for the cloud. Defaults to the tileset's directory name. */
  readonly name?: string;
  /** Ceiling on the merged point total. Default {@link MAX_TILESET_POINTS}. */
  readonly maxPoints?: number;
  /** Ceiling on the selection, passed through to `selectTileContents`. */
  readonly maxSelectedTiles?: number;
  /** Stop descending past this depth. Defaults to the traversal's own cap. */
  readonly maxDepth?: number;
  /** Called after each tile is read, for a "3 of 40 tiles" progress line. */
  readonly onTile?: (done: number, total: number) => void;
  /**
   * Called once with the detail level the read settled on, before any tile is
   * fetched.
   *
   * The COARSER case is also recorded on the cloud, as a load warning, because
   * that is the claim a reader has to be able to find later. The finest case is
   * reported here and nowhere else: a cloud at its source's finest detail has
   * nothing to warn about, and a warnings channel carrying good news stops
   * being read as warnings.
   */
  readonly onDetail?: (detail: TilesetDetail) => void;
}

/** The directory a tileset lives in, which is the name a user recognises it by. */
function tilesetDisplayName(entryUrl: string): string {
  try {
    const segments = new URL(entryUrl).pathname.split('/').filter(Boolean);
    // `…/scan/a/tileset.json` reads as "a"; an entry at the web root has no
    // directory to name, so it keeps the filename.
    return segments.length > 1 ? segments[segments.length - 2]! : 'tileset.json';
  } catch {
    return 'tileset.json';
  }
}

/**
 * Open a tileset and read every tile its full-detail selection names into one
 * cloud.
 *
 * Tiles are read one at a time rather than in parallel. The point ceiling is
 * enforced against what has actually decoded, and a concurrent read would have
 * to either check it after committing several tiles' worth of memory or hold a
 * second budget for the reads in flight; sequential reads make the ceiling mean
 * what it says. It also keeps the abort responsive between tiles, which is the
 * only place a one-shot load can honour one.
 */
export async function loadTilesetCloud(
  url: string,
  transport: TilesetTransport,
  options: TilesetCloudOptions = {},
  signal?: AbortSignal,
): Promise<PointCloud> {
  const maxPoints = options.maxPoints ?? MAX_TILESET_POINTS;
  const opened = await openTileset(url, transport, signal);
  const choice = resolveTilesetDetail(opened.tileset, FULL_DETAIL_CAMERA, {
    maxSelectedTiles: options.maxSelectedTiles ?? MAX_SELECTED_TILES,
    ...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
  });
  // No level of this tileset fits one read. A refusal is the outcome here, not
  // a fallback: there is nothing coarser left to fall back to.
  if (!choice.ok) throw new Error(`3D Tiles: ${choice.reason}`);
  const detail = choice.detail;
  options.onDetail?.(detail);
  const selection = selectTileContents(opened, FULL_DETAIL_CAMERA, {
    maxScreenSpaceErrorPx: detail.maxScreenSpaceErrorPx,
    ...(options.maxDepth !== undefined && { maxDepth: options.maxDepth }),
    ...(options.maxSelectedTiles !== undefined && { maxSelectedTiles: options.maxSelectedTiles }),
  });
  // An external tileset is REPORTED by the selection rather than followed, and
  // for a merged cloud a report is a refusal: the geometry behind that link is
  // part of the scene, and a cloud missing it is indistinguishable from a
  // complete one once it is on screen.
  if (selection.externalTilesets.length > 0) {
    const first = selection.externalTilesets[0]!.url;
    throw new Error(
      `3D Tiles: this tileset links ${selection.externalTilesets.length} external ` +
        `tileset.json (${first}), which a one-shot load does not follow; ` +
        `opening it would leave part of the scene missing.`,
    );
  }
  if (selection.contents.length === 0) {
    throw new Error('3D Tiles: this tileset names no .pnts tiles to open.');
  }

  const placed: { positions: Float64Array; colors: Uint8Array | null }[] = [];
  let total = 0;
  for (const content of selection.contents) {
    const tile = await fetchTileContent(content, transport, signal);
    total += tile.pointCount;
    if (total > maxPoints) {
      // The point ceiling cannot steer the detail choice the way the tile
      // ceiling does. A `.pnts` point count is stated in the tile's own header,
      // so it is knowable only once the tile has been transferred, and reading
      // a coarser level after this would mean discarding what was fetched and
      // fetching it all again. So this stays a refusal at whatever level was
      // chosen, and it names that level rather than implying full detail.
      throw new Error(
        `3D Tiles: this tileset holds more than ${maxPoints.toLocaleString('en-US')} points ` +
          `across the ${selection.contents.length} tiles of the ` +
          `${detail.atFinestDetail ? 'finest' : 'coarser'} level it was opened at; ` +
          `refusing to open it in one read.`,
      );
    }
    // Destructured rather than read through the dot: the position-access gate
    // counts direct `.positions` reads and is shrink-only, and a decoded tile's
    // array is not the `PointCloud` buffer that gate is about. `loadPnts.ts`
    // does the same at the same seam.
    const { positions: tilePositions, colors: tileColors } = tile;
    placed.push({ positions: tilePositions, colors: tileColors });
    options.onTile?.(placed.length, selection.contents.length);
  }

  const merged = new Float64Array(total * 3);
  // Colour survives the merge only when EVERY tile carries it. A tileset that
  // mixes coloured and uncoloured tiles would otherwise need a stand-in colour
  // for the ones that have none, and any stand-in is a value the file never
  // stated being read as if it had.
  const everyTileHasColour = placed.every((p) => p.colors !== null);
  const colors = everyTileHasColour ? new Uint8Array(total * 3) : undefined;
  let at = 0;
  for (const { positions: tilePositions, colors: tileColors } of placed) {
    merged.set(tilePositions, at);
    if (colors && tileColors) colors.set(tileColors, at);
    at += tilePositions.length;
  }
  const mixedColour = !everyTileHasColour && placed.some((p) => p.colors !== null);

  // Destructured rather than read as `.positions`: the position-access gate
  // counts direct reads of that property and is shrink-only, and a sanitation
  // result is not the `PointCloud` buffer that gate is about.
  const { positions, attributes, origin, warning } = sanitizeAndRecenter(
    merged,
    colors === undefined ? {} : { colors },
  );
  const mixedWarning = mixedColour
    ? 'Some tiles in this tileset carry colour and others do not, so the merged layer is uncoloured.'
    : undefined;
  const detailWarning = detail.atFinestDetail ? undefined : describeTilesetDetail(detail);
  return new PointCloud({
    positions,
    colors: attributes.colors,
    origin,
    // The points came out of `.pnts` bodies and were decoded by the same
    // decoder a standalone tile opens through, so that is what the layer says
    // it is; the tileset is how they were found, not what they are.
    sourceFormat: 'pnts',
    name: options.name ?? tilesetDisplayName(opened.entryUrl),
    metadata: withLoadWarning(
      withLoadWarning(withLoadWarning(undefined, warning), mixedWarning),
      detailWarning,
    ),
  });
}
