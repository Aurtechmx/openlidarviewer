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
import { resolveTilesetContentUrl, tilesetBaseUrl, tilesetUrlSearch } from './tilesetUrl';
import type { Tileset } from './tileset';

/**
 * Points assumed for a tile whose body has not been read.
 *
 * Chosen against the ceiling this repo already applies to a single point tile
 * rather than against a typical file: an estimate that is too low would admit
 * more decodes than the budget intends, which is the one direction the
 * scheduler's gate cannot absorb.
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

    const aabb = volumeToAabb(placed.boundingVolume);
    if (aabb == null) {
      skipped.push(`${uri}: bounding volume carries none of box, region or sphere.`);
      continue;
    }
    if (seen.has(uri)) {
      skipped.push(`${uri}: a second tile names the same content; only the first is served.`);
      continue;
    }
    seen.add(uri);

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
    });
    contentUri.set(uri, target);
    transform.set(uri, placed.transform);
    contentParent[placed.depth] = uri;
  }

  return { records, contentUri, transform, skipped };
}
