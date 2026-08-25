/**
 * tilesetDetail.ts — which detail level a one-shot read can actually open.
 *
 * `tilesetCloud.ts` asks the traversal for the finest representation the tree
 * offers. A tileset whose finest level names more tiles than the selection
 * ceiling therefore fails to open at all, however coarse a level of it would
 * have fitted. That is the whole reason this module exists: it picks the FINEST
 * screen-space-error threshold whose selection fits the ceiling, so a large
 * tileset opens at a level it fits at instead of not opening.
 *
 * WHY THE CANDIDATES COME FROM THE TREE. `shouldRefine` compares a tile's
 * screen-space error against the threshold with `sse > threshold`, so between
 * two consecutive tile errors every threshold decides identically. The
 * selection is therefore a step function of the threshold whose only steps are
 * the tile errors themselves, and the sorted distinct errors are the complete
 * candidate set. Searching anything else either misses the finest fitting level
 * or repeats work that cannot change the answer.
 *
 * WHY A BISECTION IS VALID. Raising the threshold can only stop refinements,
 * never start them, and a tile that stops refining contributes one selected
 * tile in place of a subtree of at least one. So the selection size is
 * non-increasing in the threshold, "fits the ceiling" is false then true along
 * the ladder, and the smallest fitting rung is found by bisection. The ladder
 * is finite (one rung per distinct tile error, plus the full-detail rung) and
 * `parseTileset` caps the tile count, so the search runs at most
 * ceil(log2(tiles + 2)) selections: 18 at the 200,000-tile parse ceiling. A
 * degenerate tree cannot make it run longer, only make its rungs coincide.
 *
 * TILES ARE KNOWABLE HERE, POINTS ARE NOT. A selection's tile count is decided
 * by the tileset document alone, which is why the ceiling this module fits
 * inside is the TILE ceiling. A `.pnts` tile states its point count in its own
 * header, not in the tileset document, which is why `MAX_TILESET_POINTS` is
 * enforced as tiles decode and cannot be part of this choice. Nothing here
 * predicts a point total, and nothing here fetches a tile to learn one.
 *
 * Pure: the parsed tree, a camera and the ceilings. No fetching, no DOM, no
 * three.js.
 */

import type { Tileset } from './tileset';
import { IDENTITY_4X4, walkTilePlacements } from './tileTransform';
import {
  distanceToAabb,
  selectTiles,
  tileScreenSpaceError,
  volumeToAabb,
  type ViewCamera,
} from './tilesetTraversal';

/** The ceilings a chosen detail level has to fit inside. */
export interface TilesetDetailCaps {
  /** Ceiling on the selection, the same one `selectTileContents` enforces. */
  readonly maxSelectedTiles: number;
  /** Stop descending past this depth. Defaults to the traversal's own cap. */
  readonly maxDepth?: number;
}

/** The detail level a read settled on, and what it cost against the finest. */
export interface TilesetDetail {
  /** The threshold to select at, in pixels of screen-space error. */
  readonly maxScreenSpaceErrorPx: number;
  /** True only when this is the finest level the tree offers. */
  readonly atFinestDetail: boolean;
  /** Tiles this level selects. */
  readonly selectedTiles: number;
  /** Tiles the finest level would have selected. */
  readonly finestTiles: number;
  /** The ceiling this level had to fit inside. */
  readonly maxSelectedTiles: number;
}

/** A resolved level, or the reason no level of this tileset fits. */
export type TilesetDetailChoice =
  | { readonly ok: true; readonly detail: TilesetDetail }
  | { readonly ok: false; readonly reason: string };

/**
 * The threshold that asks for unconditional descent.
 *
 * `shouldRefine` treats a threshold of zero or less as "never refine", so the
 * smallest positive double is the finest rung a ladder can hold. It is the
 * first rung tried, which is what keeps a tileset that already fits selecting
 * exactly what it selects today.
 */
export const FULL_DETAIL_SSE_PX = Number.MIN_VALUE;

/**
 * The depth `selectTiles` stops at when a caller names none. Repeated here
 * because the ladder has to skip the tiles that cap makes unreachable, and a
 * ladder that disagrees with the traversal about which tiles exist would offer
 * rungs that change nothing.
 */
const DEFAULT_TRAVERSAL_MAX_DEPTH = 32;

/**
 * Resolve the finest screen-space-error threshold whose selection fits.
 *
 * Returns the full-detail rung whenever it fits, so this is a no-op for every
 * tileset that opens today. Returns a refusal when even the coarsest rung does
 * not fit, which is a correct outcome: a tileset whose ROOT alone is past the
 * ceiling has no level a one-shot read can open, and a tile whose bounding
 * volume contains the camera has unbounded screen-space error and refines at
 * every finite threshold, so no rung prunes it.
 */
export function resolveTilesetDetail(
  tileset: Tileset,
  camera: ViewCamera,
  caps: TilesetDetailCaps,
): TilesetDetailChoice {
  const cap = caps.maxSelectedTiles;
  const countAt = (thresholdPx: number): number =>
    selectTiles(tileset, camera, {
      maxScreenSpaceErrorPx: thresholdPx,
      ...(caps.maxDepth !== undefined && { maxDepth: caps.maxDepth }),
    }).length;

  const finestTiles = countAt(FULL_DETAIL_SSE_PX);
  if (finestTiles <= cap) {
    return {
      ok: true,
      detail: {
        maxScreenSpaceErrorPx: FULL_DETAIL_SSE_PX,
        atFinestDetail: true,
        selectedTiles: finestTiles,
        finestTiles,
        maxSelectedTiles: cap,
      },
    };
  }

  const ladder = detailLadder(tileset, camera, caps);
  // Smallest fitting rung by bisection over a ladder whose fit is false then
  // true. `lo` stays the first index not yet ruled out; `hi` is one past the
  // last rung still worth testing.
  let lo = 0;
  let hi = ladder.length;
  let chosen: { threshold: number; tiles: number } | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const threshold = ladder[mid]!;
    const tiles = countAt(threshold);
    if (tiles <= cap) {
      chosen = { threshold, tiles };
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  if (!chosen) {
    // The coarsest rung is what the tileset cannot go below, so its size is the
    // honest number to name: it says the ceiling was not merely overshot by the
    // finest level.
    const coarsest = ladder.length > 0 ? countAt(ladder[ladder.length - 1]!) : finestTiles;
    return {
      ok: false,
      reason:
        `this tileset selects ${coarsest.toLocaleString('en-US')} tiles even at its coarsest ` +
        `level, past the ${cap.toLocaleString('en-US')}-tile ceiling for one read; ` +
        `no level of it opens in a single read.`,
    };
  }
  return {
    ok: true,
    detail: {
      maxScreenSpaceErrorPx: chosen.threshold,
      atFinestDetail: false,
      selectedTiles: chosen.tiles,
      finestTiles,
      maxSelectedTiles: cap,
    },
  };
}

/**
 * What a cloud says about the detail it was opened at.
 *
 * A cloud opened coarser than its source MUST say so, in the same voice the
 * measurement surfaces state a basis in: what was read, then what that leaves
 * the reader entitled to claim. Silence on a coarser read is the failure this
 * whole module is guarding, because a coarser tileset looks like a complete one
 * on screen and measures like a thinner one.
 */
export function describeTilesetDetail(detail: TilesetDetail): string {
  const selected = detail.selectedTiles.toLocaleString('en-US');
  if (detail.atFinestDetail) {
    return `Opened at this tileset's finest detail, ${selected} tiles.`;
  }
  return (
    `Opened coarser than this tileset's finest detail: full detail names ` +
    `${detail.finestTiles.toLocaleString('en-US')} tiles, past the ` +
    `${detail.maxSelectedTiles.toLocaleString('en-US')}-tile ceiling for one read, so the ` +
    `finest level that fits was opened instead, at ${selected} tiles.`
  );
}

/**
 * The thresholds worth testing, from finest to coarsest.
 *
 * One rung per distinct finite positive tile error, ascending, behind the
 * full-detail rung. A threshold equal to a tile's own error stops that tile
 * refining, so the coarsest rung is the largest error in the tree, at which
 * nothing with a finite error refines. Errors of zero are left out: a tile
 * stating no error never refines at any threshold, so it is not a step.
 *
 * Measured over EVERY placed tile, not over a selection. Under REPLACE
 * refinement a refined parent is absent from the selection it produced, and its
 * error is precisely the rung at which that parent stops refining, so a ladder
 * built from a selection would be missing the steps that coarsen it.
 */
function detailLadder(tileset: Tileset, camera: ViewCamera, caps: TilesetDetailCaps): number[] {
  const maxDepth = caps.maxDepth ?? DEFAULT_TRAVERSAL_MAX_DEPTH;
  const errors = new Set<number>();
  for (const placed of walkTilePlacements(tileset.root, IDENTITY_4X4)) {
    // Tiles past the depth cap are never reached, so their errors are not steps
    // any reachable selection can turn on.
    if (placed.depth > maxDepth) continue;
    const aabb = volumeToAabb(placed.boundingVolume);
    if (!aabb) continue;
    const distance = distanceToAabb(aabb, camera.positionEcef as [number, number, number]);
    const sse = tileScreenSpaceError(camera, placed.geometricError, distance);
    if (Number.isFinite(sse) && sse > 0) errors.add(sse);
  }
  return [FULL_DETAIL_SSE_PX, ...[...errors].sort((a, b) => a - b)];
}
