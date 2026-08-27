/**
 * TilesetStreamingSource.ts — a 3D Tiles tileset as a streaming source.
 *
 * The scheduler, the renderer and the picking path all read a source through
 * {@link StreamingSource} and never learn which format is behind it. COPC and
 * EPT satisfy it as octrees of LAZ chunks. A tileset satisfies it as a tree of
 * separately addressed `.pnts` bodies, which the interface already allows:
 * `readNodeChunk` is the seam where a source turns a node into bytes however
 * its format requires, and the decoder is injected rather than assumed.
 *
 * What this source does NOT do, deliberately:
 *
 *   Implicit tiling. `tilesetNodes` walks the explicit tree, so a tileset that
 *   declares subtrees produces no nodes for them. The parser already refuses
 *   such a document, so this cannot silently under-serve one.
 *
 *   Mesh content. A tile whose content is not a point tile has no place in a
 *   point cloud, and the parser refuses those too.
 *
 * POINT COUNTS. `sourcePointCount` is null rather than a sum of the per-node
 * estimates. The estimates exist to govern decode admission and are not
 * measurements, so adding them up would put a fabricated total in front of a
 * user and into the scan report. Null is the interface's way of saying the
 * format does not state it.
 */

import type { Box6, StreamingNodeRecord } from '../../io/copc/copcTypes';
import type { CrsInfo } from '../../io/crs';
import type { SpatialFrame } from '../../geo/frame/spatialFrame';
import { createTranslatedFrame } from '../../geo/frame/spatialFrame';
import type { Mat4 } from '../../io/tiles3d/tileTransform';
import type { TilesetTransport } from '../../io/tiles3d/tilesetTransport';
import { PNTS_COLOR_MODES, type PntsDecodeMetadata } from '../../io/tiles3d/pntsDecode';
import { tilesetNodes, type TilesetNodeIndex } from '../../io/tiles3d/tilesetNodes';
import { volumeToAabb } from '../../io/tiles3d/tilesetTraversal';
import { declaredTilesetFrame, enuFrameMatrix } from '../../io/tiles3d/tilesetFrame';
import type { Tileset } from '../../io/tiles3d/tileset';
import { StreamingNodeStore } from './StreamingNodeStore';
import type { NodeCounts } from './StreamingNodeStore';
import type { StreamingNode } from './StreamingNode';
import type {
  NodeDecodeMetadata,
  StreamingColorMode,
  StreamingOctreeView,
  StreamingSource,
  StreamingSourceKind,
} from './StreamingSource';

/**
 * The root transform that puts a geocentric tileset in a local ENU frame, or
 * null when the document declares no such frame.
 *
 * A merged reader anchors on the extent centre of every point it loaded. A
 * streaming reader has no such buffer and its resident set changes as the
 * camera moves, so it anchors on the ROOT BOUNDING VOLUME's centre instead:
 * that is fixed by the document, so the rotation, and with it every render
 * coordinate, is the same on every run and at every camera position.
 *
 * Without this the points arrive in ECEF, where +Z is the polar axis rather
 * than local up. The scene still frames and still draws; only the heights and
 * the verticals read off it are wrong, which is a failure with no visual trace.
 */
export function tilesetRootFrameMatrix(tileset: Tileset): Mat4 | null {
  if (!declaredTilesetFrame(tileset).geocentric) return null;
  const aabb = volumeToAabb(tileset.root.boundingVolume);
  if (aabb == null) return null;
  const anchor: [number, number, number] = [
    (aabb.min[0] + aabb.max[0]) / 2,
    (aabb.min[1] + aabb.max[1]) / 2,
    (aabb.min[2] + aabb.max[2]) / 2,
  ];
  if (!anchor.every(Number.isFinite) || Math.hypot(...anchor) === 0) return null;
  return enuFrameMatrix(anchor) as Mat4;
}

/** The union of every node's bounds, or null when there are no nodes. */
function unionBounds(records: readonly StreamingNodeRecord[]): Box6 | null {
  if (records.length === 0) return null;
  const b: number[] = [...records[0].bounds];
  for (const r of records) {
    for (let i = 0; i < 3; i++) {
      if (r.bounds[i] < b[i]) b[i] = r.bounds[i];
      if (r.bounds[i + 3] > b[i + 3]) b[i + 3] = r.bounds[i + 3];
    }
  }
  return b as Box6;
}

/** Centre of a box, used as the render origin so float32 keeps its precision. */
function centreOf(b: Box6): [number, number, number] {
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

/** The octree-shaped view the scheduler reads. A tileset tree is not an octree. */
class TilesetTreeView implements StreamingOctreeView {
  readonly store = new StreamingNodeStore();
  readonly errors: readonly string[];

  constructor(index: TilesetNodeIndex) {
    for (const record of index.records) this.store.add(record);
    for (const record of index.records) {
      if (record.parentId == null) continue;
      this.store.get(record.parentId)?.childIds.push(record.id);
    }
    this.errors = index.skipped;
  }

  nodes(): StreamingNode[] {
    return this.store.all();
  }

  /** Complete when the walk kept every tile it met. A skip is a dropped tile. */
  get isComplete(): boolean {
    return this.errors.length === 0;
  }
}

/** A tileset served through the streaming pipeline. */
export class TilesetStreamingSource implements StreamingSource {
  readonly kind: StreamingSourceKind = '3dtiles';
  readonly renderOrigin: [number, number, number];
  readonly frame: SpatialFrame;
  readonly octree: StreamingOctreeView;

  readonly id: string;
  readonly name: string;

  private readonly _index: TilesetNodeIndex;
  private readonly _bounds: Box6;
  private readonly _transport: TilesetTransport;
  private readonly _crs: CrsInfo | null;

  constructor(
    id: string,
    name: string,
    baseUrl: string,
    transport: TilesetTransport,
    tileset: Tileset,
    rootTransform?: Mat4,
    crs: CrsInfo | null = null,
  ) {
    this.id = id;
    this.name = name;
    this._transport = transport;
    this._crs = crs;
    // Resolved here rather than by the caller: a caller that forgets leaves a
    // geocentric tileset in ECEF, and nothing on screen says so.
    // The entry URL is passed so every content URI is resolved and VALIDATED
    // before a tile is fetched. Without it the index would hand the transport
    // whatever the document wrote.
    this._index = tilesetNodes(
      tileset,
      rootTransform ?? tilesetRootFrameMatrix(tileset) ?? undefined,
      baseUrl,
    );
    this._bounds = unionBounds(this._index.records) ?? [0, 0, 0, 0, 0, 0];
    this.renderOrigin = centreOf(this._bounds);
    this.frame = createTranslatedFrame(this.renderOrigin);
    this.octree = new TilesetTreeView(this._index);
  }

  /**
   * Null on purpose: a tileset states no point total, and the per-node numbers
   * are admission estimates rather than counts. See the note at the top.
   */
  get sourcePointCount(): number | null {
    return null;
  }

  get residentPointCount(): number {
    return this.octree.store.residentPointCount;
  }

  counts(): NodeCounts {
    return this.octree.store.counts();
  }

  maxDepth(): number {
    let d = 0;
    for (const node of this.octree.nodes()) if (node.record.depth > d) d = node.record.depth;
    return d;
  }

  /** Bounds relative to the render origin, which is what the culler works in. */
  localBounds(): Box6 {
    const [rx, ry, rz] = this.renderOrigin;
    const b = this._bounds;
    return [b[0] - rx, b[1] - ry, b[2] - rz, b[3] - rx, b[4] - ry, b[5] - rz];
  }

  /** The tileset's own bounds, before the render origin is taken out. */
  dataBounds(): Box6 {
    return [...this._bounds] as Box6;
  }

  defaultColorMode(): StreamingColorMode {
    return 'rgb';
  }

  /**
   * Only what a point tile can carry. Intensity, classification and returns are
   * absent from the format, so nothing offers to paint a scan by them.
   */
  availableColorModes(): readonly StreamingColorMode[] {
    return PNTS_COLOR_MODES;
  }

  crs(): CrsInfo | null {
    return this._crs;
  }

  async readNodeChunk(record: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> {
    // Already absolute and already validated by the index. Re-resolving here
    // against the base would undo that check for an authored absolute URL.
    const url = this._index.contentUri.get(record.id);
    if (url == null) throw new Error(`No content URL for tile ${record.id}.`);
    return this._transport.fetchTileBytes(url, signal);
  }

  decodeMeta(record: StreamingNodeRecord): NodeDecodeMetadata {
    const transform = this._index.transform.get(record.id);
    if (transform == null) throw new Error(`No transform for tile ${record.id}.`);
    const meta: PntsDecodeMetadata = {
      format: 'pnts',
      tileTransform: transform,
      renderOrigin: this.renderOrigin,
    };
    return meta;
  }
}
