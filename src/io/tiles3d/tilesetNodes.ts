/**
 * tilesetNodes.ts — turn a parsed tileset into the streaming node model.
 *
 * The scheduler culls, scores and budgets over a flat store of nodes, each
 * carrying an id, a depth, world bounds and a point count. A tileset carries
 * the first three directly once its tree is walked. The fourth it does not
 * carry at all, which is the one interesting decision here.
 *
 * POINT COUNTS. A `tileset.json` never states how many points a tile holds;
 * only the `.pnts` body knows, and reading every body to find out would defeat
 * the point of streaming. So each node is admitted with an ESTIMATE, and the
 * estimate is deliberately high. The scheduler's own admission gate documents
 * why that is the safe direction: it refuses to start a decode while resident
 * plus in-flight already sits at the pressure cap, and "small over-estimates
 * only mean we dispatch slightly fewer decodes when at the boundary, never
 * more". Once a tile decodes, the store holds its true resident count, so the
 * estimate governs admission only and never what the viewer reports.
 *
 * IDENTITY. A node is identified by its content URI resolved against the
 * tileset, which is stable across runs and unique per body. Tiles without
 * content are structure, not data: they are walked for their transform and
 * their children but produce no node, because there is nothing to fetch.
 *
 * Pure: no fetch, no DOM.
 */

import type { Box6, StreamingNodeRecord } from '../copc/copcTypes';
import type { Mat4 } from './tileTransform';
import { walkTilePlacements } from './tileTransform';
import { volumeToAabb } from './tilesetTraversal';
import type { Aabb } from './boundingVolume';
import { resolveTilesetContentUrl, tilesetBaseUrl, tilesetUrlSearch } from './tilesetUrl';
import type { Tile, Tileset } from './tileset';

/**
 * Points assumed for a tile whose body has not been read.
 *
 * A `tileset.json` never states a tile's point count, so the scheduler admits
 * a node on an ESTIMATE. This estimate drives throughput accounting only —
 * resident pressure, in-flight pressure and concurrency — not a memory-safety
 * bound: it is deliberately on the high side of a typical tile so that at the
 * budget boundary the scheduler dispatches slightly fewer decodes rather than
 * slightly more, the one direction its admission gate can absorb.
 *
 * It is NOT the ceiling a malicious tile could reach. A body may legally
 * declare far more points than this, and the memory bound that refuses such a
 * body lives where the real `POINTS_LENGTH` is known before allocation: the
 * PNTS decoder's decoded-byte ceiling (see {@link MAX_PNTS_TILE_POINTS} and the
 * decoded-byte budget in `pnts.ts`). Inflating this estimate to that ceiling
 * would starve normal streaming, treating a few-hundred-point tile as millions.
 */
export const ASSUMED_TILE_POINTS = 500_000;

/**
 * How a content URI's filename classifies. Query and fragment are ignored.
 *
 * Extension-based, and cheap on purpose: a `.b3dm` or `.glb` is a real 3D Tiles
 * content type this viewer has no decoder for, and fetching one to discover
 * that wastes the transfer. 3D Tiles 1.1 does not require an extension, so a
 * URI carrying none is `unknown` rather than assumed to be a point tile.
 */
export function contentKind(uri: string): 'pnts' | 'tileset' | 'other' | 'unknown' {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith('.pnts')) return 'pnts';
  if (path.endsWith('.json')) return 'tileset';
  const last = path.split('/').pop() ?? '';
  return last.includes('.') ? 'other' : 'unknown';
}

/** What a streaming source needs to serve a tileset's tiles. */
export interface TilesetNodeIndex {
  /** One record per tile that has content, in walk order. */
  readonly records: readonly StreamingNodeRecord[];
  /**
   * Node id to the ABSOLUTE, validated URL to fetch.
   *
   * Resolved here rather than at fetch time so a document naming a URL this
   * reader must not request is refused before a single tile is fetched. The
   * authored URI is never handed to the transport: `resolveTilesetContentUrl`
   * refuses a non-http scheme, embedded credentials, a private-network host, a
   * different origin from the tileset, and a path escaping the tileset's own
   * directory. A `tileset.json` is an untrusted document that names URLs the
   * viewer will request, so those are not optional.
   */
  readonly contentUri: ReadonlyMap<string, string>;
  /** Node id to the cumulative root-to-tile transform the decoder must apply. */
  readonly transform: ReadonlyMap<string, Mat4>;
  /** Tiles skipped, and why. Never silent: a dropped tile is missing data. */
  readonly skipped: readonly string[];
}

/**
 * A region's bounds put in the same frame as the points that fill them.
 *
 * `volumeToAabb` converts a `region` DIRECTLY to ECEF, because a region is
 * EPSG:4979 and absolute; a box or a sphere arrives already carried through the
 * tile transform by the walk. The points of a geocentric tileset, though, are
 * decoded through that transform, root frame included, so they land in the
 * local ENU frame while a region's box stayed 6,000 km away at the ECEF radius.
 * The scheduler culls node bounds against the camera, so bounds in one frame
 * and points in another means it culls against nothing the user is looking at.
 *
 * All eight corners are carried across and re-bounded, which is conservative:
 * a rotated box's axis-aligned bound is larger than the original, never smaller,
 * so a tile can be admitted that need not have been but none is culled that
 * should have been drawn.
 */
function aabbThroughMatrix(aabb: Aabb, m: readonly number[]): Aabb {
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (const cx of [aabb.min[0], aabb.max[0]]) {
    for (const cy of [aabb.min[1], aabb.max[1]]) {
      for (const cz of [aabb.min[2], aabb.max[2]]) {
        xs.push(m[0] * cx + m[4] * cy + m[8] * cz + m[12]);
        ys.push(m[1] * cx + m[5] * cy + m[9] * cz + m[13]);
        zs.push(m[2] * cx + m[6] * cy + m[10] * cz + m[14]);
      }
    }
  }
  return {
    min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
    max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
  };
}

/** Whether any tile below this one carries content of its own. */
function subtreeHasContent(tile: Tile): boolean {
  for (const child of tile.children) {
    if (child.contentUri !== null || subtreeHasContent(child)) return true;
  }
  return false;
}

/** An AABB as the streaming model's flat six-number box. */
function toBox6(min: readonly number[], max: readonly number[]): Box6 {
  return [min[0], min[1], min[2], max[0], max[1], max[2]];
}

/**
 * Build the node index for a tileset.
 *
 * `rootTransform` places the whole tileset, which is how a geocentric tileset
 * is brought into a local ENU frame before anything is bounded or culled.
 */
export function tilesetNodes(
  tileset: Tileset,
  rootTransform?: Mat4,
  entryUrl?: string,
): TilesetNodeIndex {
  // Without an entry URL there is nothing to resolve against, which is the
  // shape the pure unit tests use. A caller that fetches MUST pass one; the
  // streaming source does.
  const base = entryUrl === undefined ? null : tilesetBaseUrl(entryUrl);
  const search = entryUrl === undefined ? '' : tilesetUrlSearch(entryUrl);
  const records: StreamingNodeRecord[] = [];
  const contentUri = new Map<string, string>();
  const transform = new Map<string, Mat4>();
  const skipped: string[] = [];
  const seen = new Set<string>();
  // REPLACE means a refined tile's content is replaced by its children, so the
  // parent must not be drawn once they are selected. The streaming scheduler
  // has no such rule: it draws every resident node, which is exactly right for
  // ADD and duplicates geometry for REPLACE, over-reporting displayed points
  // along with it. Rather than draw a scene that is quietly wrong, a REPLACE
  // tile that actually refines into content is refused by name.
  //
  // A REPLACE tile whose subtree holds no further content refines into nothing,
  // so nothing can be duplicated and it is served.
  const replacing: string[] = [];
  // Nearest ancestor WITH content, so the store's parent chain skips the
  // structural tiles that produce no node of their own.
  const contentParent: string[] = [];

  for (const placed of walkTilePlacements(tileset.root, rootTransform)) {
    contentParent.length = Math.min(contentParent.length, placed.depth);
    const uri = placed.tile.contentUri;
    if (uri == null) continue;

    // Only a point tile becomes a node. Everything else would be fetched and
    // handed to the point-tile decoder, which is a runtime failure on bytes
    // that were never point data. A skip is recorded so the caller can refuse
    // the open rather than draw a scene with pieces silently absent.
    const kind = contentKind(uri);
    if (kind !== 'pnts') {
      skipped.push(
        kind === 'tileset'
          ? `${uri}: an external tileset, which this reader does not follow.`
          : kind === 'unknown'
            ? `${uri}: names no file extension, so its content type is undeclared.`
            : `${uri}: not a point tile, and this viewer decodes no other content.`,
      );
      continue;
    }

    const raw = volumeToAabb(placed.boundingVolume);
    // A region skipped the walk's transform, so it needs the root frame applied
    // here or its bounds describe a different place from its points.
    const aabb =
      raw !== null && placed.boundingVolume.region !== undefined && rootTransform !== undefined
        ? aabbThroughMatrix(raw, rootTransform)
        : raw;
    if (aabb == null) {
      skipped.push(`${uri}: bounding volume carries none of box, region or sphere.`);
      continue;
    }
    if (seen.has(uri)) {
      skipped.push(`${uri}: a second tile names the same content; only the first is served.`);
      continue;
    }
    seen.add(uri);

    if (placed.tile.refine === 'REPLACE' && subtreeHasContent(placed.tile)) {
      replacing.push(uri);
    }

    // Refused before anything is fetched, and named, so the open can say which
    // tile it would have had to request.
    let target = uri;
    if (base !== null) {
      const resolved = resolveTilesetContentUrl(base, uri, search);
      if (!resolved.ok) {
        skipped.push(`${uri}: ${resolved.reason}`);
        continue;
      }
      target = resolved.url;
    }

    // Nearest ANCESTOR that produced a node, which may be several levels up:
    // a chain of structural tiles leaves those depths unset, and looking only
    // one level up left such a leaf parentless.
    let parentId: string | undefined;
    for (let d = placed.depth - 1; d >= 0; d--) {
      if (contentParent[d] != null) {
        parentId = contentParent[d];
        break;
      }
    }

    records.push({
      id: uri,
      // The streaming model still types a voxel key. A tileset has none, so
      // the depth is repeated into it rather than inventing coordinates that
      // would read as an octree address. Nothing consumes it for this source:
      // the scheduler refines on `depth`.
      key: { depth: placed.depth, x: 0, y: 0, z: 0 },
      depth: placed.depth,
      bounds: toBox6(aabb.min, aabb.max),
      pointCount: ASSUMED_TILE_POINTS,
      // A tile is a separate resource, not a range inside one file.
      byteOffset: 0,
      byteSize: 0,
      spacing: placed.geometricError,
      parentId,
      // The document's own value, resolved by the parser (a child inherits its
      // parent's when it declares none). Only ADD, and REPLACE that refines
      // into nothing, get this far — a REPLACE tile with content below it is
      // named in `replacing` and refuses the open — so a served node is never a
      // replaced ancestor of another. Carrying the value anyway keeps the
      // export frontier reading the tile rather than a default.
      refine: placed.tile.refine === 'REPLACE' ? 'replace' : 'add',
    });
    contentUri.set(uri, target);
    transform.set(uri, placed.transform);
    contentParent[placed.depth] = uri;
  }

  for (const uri of replacing) {
    skipped.push(
      `${uri}: refines by REPLACE into tiles with their own content, which this ` +
        `reader would draw alongside it rather than instead of it.`,
    );
  }

  return { records, contentUri, transform, skipped };
}
