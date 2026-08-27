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
import type { SpatialFrame, Vec3 } from '../../geo/frame/spatialFrame';
import { createTranslatedFrame } from '../../geo/frame/spatialFrame';
import type { CloudFrameProvenance } from '../../geo/frame/frameProvenance';
import type { Mat4 } from '../../io/tiles3d/tileTransform';
import type { TilesetTransport } from '../../io/tiles3d/tilesetTransport';
import {
  NO_TILE_DECODED,
  NO_TILE_DECODED_NORMALS,
  noteTileColour,
  noteTileNormals,
  PNTS_COLOR_MODES,
  type PntsDecodeMetadata,
  type TilesetColourConsensus,
  type TilesetNormalsConsensus,
} from '../../io/tiles3d/pntsDecode';
import { tilesetNodes, type TilesetNodeIndex } from '../../io/tiles3d/tilesetNodes';
import { volumeToAabb } from '../../io/tiles3d/tilesetTraversal';
import {
  resolveStreamingTilesetFrame,
  type StreamingTilesetFrame,
} from '../../io/tiles3d/tilesetFrame';
import type { Tileset } from '../../io/tiles3d/tileset';
import { StreamingNodeStore } from './StreamingNodeStore';
import type { NodeCounts } from './StreamingNodeStore';
import type { StreamingNode } from './StreamingNode';
import type {
  DecodedChunk,
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
  return (tilesetRootFrame(tileset).rootTransform as Mat4 | null) ?? null;
}

/**
 * The root transform AND the record of how it was arrived at, from one call.
 *
 * Asking for the two separately is how a tileset ends up rotated and recorded
 * as unrotated, or recorded as levelled while its tiles stayed in ECEF. The
 * resolver decides once and returns both.
 *
 * The anchor is the centre of the ROOT bounding volume, fixed by the document,
 * so the rotation is the same on every run and at every camera position — a
 * streaming reader's resident set is not.
 */
export function tilesetRootFrame(tileset: Tileset): StreamingTilesetFrame {
  const aabb = volumeToAabb(tileset.root.boundingVolume);
  const anchor: Vec3 | null =
    aabb == null
      ? null
      : [
          (aabb.min[0] + aabb.max[0]) / 2,
          (aabb.min[1] + aabb.max[1]) / 2,
          (aabb.min[2] + aabb.max[2]) / 2,
        ];
  return resolveStreamingTilesetFrame(tileset, anchor);
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
  /**
   * What this document actually said about its root frame.
   *
   * A tileset carrying only a `box` or a `sphere` declares nothing, so `basis`
   * is `unknown` and there is no vertical reference. That is a fact the source
   * states rather than one a consumer has to re-derive, and it is the only
   * thing separating a tileset whose up axis was established from one whose was
   * not — the two draw identically.
   */
  readonly frameProvenance: CloudFrameProvenance;
  readonly octree: StreamingOctreeView;

  readonly id: string;
  readonly name: string;

  private readonly _index: TilesetNodeIndex;
  private readonly _bounds: Box6;
  private readonly _transport: TilesetTransport;
  private readonly _crs: CrsInfo | null;
  /** What the tiles served so far have stated about colour and about normals. */
  private _colour: TilesetColourConsensus = NO_TILE_DECODED;
  private _normals: TilesetNormalsConsensus = NO_TILE_DECODED_NORMALS;

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
    const resolved = tilesetRootFrame(tileset);
    // An injected transform is not something the document declared, so the
    // document's declaration no longer describes the render coordinates and the
    // frame goes back to unestablished. Recording the document's answer beside
    // somebody else's transform is the mismatch this whole record exists to
    // prevent.
    this.frameProvenance =
      rootTransform === undefined
        ? resolved.provenance
        : { basis: 'unknown', declaredBy: null, verticalReference: 'unknown', linearUnit: 'metre' };
    // The entry URL is passed so every content URI is resolved and VALIDATED
    // before a tile is fetched. Without it the index would hand the transport
    // whatever the document wrote.
    this._index = tilesetNodes(
      tileset,
      rootTransform ?? (resolved.rootTransform as Mat4 | null) ?? undefined,
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

  /**
   * Fold one served chunk into this layer's answer about colour and normals.
   *
   * The decoder holds the same two answers and uses them to decide what to
   * serve; this holds them to decide what to OFFER, and folds them from the
   * chunks that actually arrived so the two cannot describe different tilesets.
   * Both use the same rule and the same pure fold: the first tile with points
   * settles the answer and it never moves.
   */
  noteDecodedChannels(chunk: DecodedChunk): void {
    this._colour = noteTileColour(this._colour, {
      pointCount: chunk.pointCount,
      hasColour: chunk.rgb !== undefined,
    });
    this._normals = noteTileNormals(this._normals, {
      pointCount: chunk.pointCount,
      hasNormals: chunk.normals !== undefined,
    });
  }

  /**
   * Elevation until a tile has stated colour, which is what the layer will
   * actually be drawn by.
   *
   * It used to return `'rgb'` unconditionally. A tileset whose tiles state no
   * colour therefore opened on a mode that fell through to the elevation ramp,
   * so the scan was painted by height under a Color chip — the same defect as
   * offering a Normal chip for a layer with no normals, one step earlier.
   */
  defaultColorMode(): StreamingColorMode {
    return this._colour.settled === 'colour' ? 'rgb' : 'elevation';
  }

  /**
   * Only what this layer's tiles have actually stated.
   *
   * Intensity, classification and returns are absent from the format, so
   * nothing offers to paint a scan by them. Colour and normals are stated per
   * TILE rather than per document, so neither is offered before a tile has been
   * read, and neither is offered for a layer whose tiles carry none: a chip
   * that silently resolves to another channel says the scan holds a reading it
   * does not.
   */
  availableColorModes(): readonly StreamingColorMode[] {
    const modes: StreamingColorMode[] = PNTS_COLOR_MODES.filter(
      (mode) => mode !== 'rgb' || this._colour.settled === 'colour',
    );
    if (this._normals.settled === 'normals') modes.push('normal');
    return modes;
  }

  /**
   * Never. A `pnts` tile has no GPS time semantic to carry: its feature table
   * defines positions, colours and normals, and a batch table holds authored
   * per-feature properties whose meaning the format does not fix. Nothing in a
   * tileset promises an acquisition timestamp per point, so there is no time to
   * export and no reading of any tile that could produce one.
   */
  hasGpsTime(): boolean {
    return false;
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
