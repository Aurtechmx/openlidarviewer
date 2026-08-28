/**
 * OlvTileSource.ts — stream a built tile store through the existing scheduler.
 *
 * The out-of-core build ends with an octree of tiles on disk: `oocIndexer`
 * settles every point at the coarsest cell with room, `tileStore` writes the
 * manifest and hierarchy that describe the result, and `TileChunkDecoder` turns
 * one tile's bytes back into the parallel arrays the renderer uploads. This
 * module presents all of that as a {@link StreamingSource}, so residency,
 * scoring, eviction, backpressure and GPU commit come from `StreamingScheduler`
 * rather than from a second scheduler written for tiles.
 *
 * Two properties of the store keep the adapter small. The hierarchy file lists
 * every occupied node with its point count, so the whole index is known after
 * one small read and there is no progressive hierarchy walk to run (a COPC page
 * tree or an EPT sub-file frontier). And the octant path is the node identity:
 * the level-`d` ancestor of a node is the first `d` characters of its key, which
 * is the same relationship the scheduler's ancestor protection derives by
 * shifting a {@link VoxelKey}, so the two agree by construction.
 *
 * Frames. Tile records hold positions exactly as the loader wrote them:
 * source-local float32, already recentred against the manifest's `origin`, and
 * the octree cube was fitted to those same positions. So the render origin IS
 * that stored origin (world = local + origin), while `decodeMeta` asks the
 * decoder for no further shift at all, because the recentring already happened
 * at build time. Getting either half wrong moves the whole cloud: a zero render
 * origin would present source-local numbers as world ones, and a non-zero decode
 * origin would subtract the shift twice.
 *
 * That leaves one frame the manifest does NOT store: a node's `bounds`. The
 * scheduler localises every node as `record.bounds - renderOrigin` (see
 * `StreamingScheduler._localBoundsFor`), the same subtraction it applies to COPC
 * and EPT records, so node bounds are WORLD — the stored cube plus the origin.
 * Handing it the build-local cube instead ran the subtraction a second time and
 * put every node one whole origin from the camera: for a UTM build that is
 * hundreds of kilometres, so the frustum culled the entire hierarchy, every node
 * scored 0, and the scan streamed nothing with no error anywhere. The figures
 * this class reports for framing — {@link OlvTileSource.localBounds} and
 * {@link OlvTileSource.dataBounds} — are the local ones, matching COPC's
 * `localBounds`, which is `world - renderOrigin`; they read the manifest
 * unshifted because the build already stored them local.
 *
 * Pure — no DOM, no three.js, no OPFS. Tile bytes arrive through an injected
 * {@link TileBytesReader}, so the whole path runs in Node against a memory map.
 */

import type { ChunkDecodeMetadata } from '../copc/copcChunkDecode';
import type { Box6, StreamingNodeRecord, VoxelKey } from '../copc/copcTypes';
import type { CrsInfo } from '../crs';
import type { NodeCounts } from '../../render/streaming/StreamingNodeStore';
import { StreamingNodeStore } from '../../render/streaming/StreamingNodeStore';
import type {
  StreamingColorMode,
  StreamingOctreeView,
  StreamingSource,
} from '../../render/streaming/StreamingSource';
import type { TileStoreReader } from './tileStore';
import { createTranslatedFrame, type SpatialFrame } from '../../geo/frame/spatialFrame';
import type { PreviewSample } from './previewSampler';

/**
 * Node ids carry a one-character prefix because the root's octant path is the
 * empty string, which would otherwise be an empty id. The prefix also keeps a
 * tile id visibly distinct from a COPC `depth-x-y-z` id in any diagnostic that
 * prints both.
 */
const ID_PREFIX = 't';

/** The node id for an octant path. */
export function tileNodeId(key: string): string {
  return ID_PREFIX + key;
}

/** The octant path behind a node id, inverse of {@link tileNodeId}. */
export function tileKeyOf(id: string): string {
  if (!id.startsWith(ID_PREFIX)) {
    throw new Error(`OlvTileSource: ${JSON.stringify(id)} is not a tile node id`);
  }
  return id.slice(ID_PREFIX.length);
}

/**
 * The {@link VoxelKey} for an octant path. The path is written most-significant
 * level first (see `octreeGrid.leafKeyFor`), so each character shifts one bit
 * into each axis; dropping the last character is exactly the `>> 1` the
 * scheduler applies when it walks to a parent.
 */
export function tileVoxelKey(key: string): VoxelKey {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const ch of key) {
    const digit = ch.charCodeAt(0) - 48;
    x = (x << 1) | (digit & 1);
    y = (y << 1) | ((digit >> 1) & 1);
    z = (z << 1) | ((digit >> 2) & 1);
  }
  return { depth: key.length, x, y, z };
}

/** Reads one tile's stored bytes. A memory map in tests, OPFS in the browser. */
export interface TileBytesReader {
  read(key: string, signal?: AbortSignal): Promise<Uint8Array>;
}

/**
 * The index as a {@link StreamingOctreeView}: every occupied node from the
 * hierarchy, linked parent to child.
 *
 * The build's placement rule occupies a node only once every ancestor is full,
 * so every proper prefix of an occupied key must itself be occupied; a store
 * that breaks that has lost nodes between the build and the read. Such a node is
 * still added, since dropping it would lose its points as well, but the gap is
 * recorded and {@link isComplete} goes false, so a completeness-sensitive
 * consumer refuses to claim the cloud is whole.
 */
export class OlvTileOctree implements StreamingOctreeView {
  readonly store = new StreamingNodeStore();
  private readonly _errors: string[] = [];

  constructor(reader: TileStoreReader) {
    const keys = reader
      .leaves()
      .map((l) => l.key)
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    const present = new Set(keys);
    const rootSize = reader.manifest.root.size;
    // World = stored + origin: the scheduler subtracts `renderOrigin` from
    // these bounds to get render space, so they have to start in the same frame
    // that origin is expressed in. See the frames note at the top of the file.
    const [ox, oy, oz] = reader.manifest.origin;

    for (const key of keys) {
      const parentKey = key.length > 0 ? key.slice(0, -1) : null;
      if (parentKey !== null && !present.has(parentKey)) {
        this._errors.push(
          `tile store: node ${JSON.stringify(key)} has no parent ${JSON.stringify(parentKey)}`,
        );
      }
      const cube = reader.cubeFor(key);
      const bounds: Box6 = [
        cube.min[0] + ox,
        cube.min[1] + oy,
        cube.min[2] + oz,
        cube.min[0] + cube.size + ox,
        cube.min[1] + cube.size + oy,
        cube.min[2] + cube.size + oz,
      ];
      this.store.add({
        id: tileNodeId(key),
        key: tileVoxelKey(key),
        depth: tileVoxelKey(key).depth,
        bounds,
        pointCount: reader.pointCountOf(key),
        // A tile is addressed by key, not by a file range, so there is no offset
        // or size to record; `readNodeChunk` reads through the bytes reader.
        byteOffset: 0,
        byteSize: 0,
        spacing: rootSize / 2 ** key.length,
        parentId: parentKey === null ? undefined : tileNodeId(parentKey),
        // Pyramid placement puts each point at the coarsest cell with room, so
        // an interior node holds points its children do not repeat: the stored
        // counts sum to the source total. Its children add to it.
        refine: 'add',
      });
    }

    // Parents sort before their children, so every parent is already in the
    // store by the time its child is linked.
    for (const node of this.store.iterate()) {
      const parentId = node.record.parentId;
      if (parentId === undefined) continue;
      this.store.get(parentId)?.childIds.push(node.record.id);
    }

    if (keys.length !== reader.manifest.leafCount) {
      this._errors.push(
        `tile store: manifest declares ${reader.manifest.leafCount} nodes but the hierarchy lists ${keys.length}`,
      );
    }
  }

  nodes() {
    return this.store.all();
  }

  get errors(): readonly string[] {
    return this._errors;
  }

  get isComplete(): boolean {
    return this._errors.length === 0;
  }
}

export interface OlvTileSourceOptions {
  /** The shell id for this streaming session — see {@link StreamingSource.id}. */
  readonly id: string;
  /** Display name surfaced in the UI. */
  readonly name: string;
  /** The parsed index. */
  readonly store: TileStoreReader;
  /** Where tile bytes come from. */
  readonly tiles: TileBytesReader;
  /**
   * The CRS the source file declared, when the caller recovered one. The
   * manifest carries no projection of its own, so a source built without this
   * reports no CRS rather than guessing one.
   */
  readonly crs?: CrsInfo | null;
  /** Release whatever backs {@link tiles} — an OPFS directory, a file handle. */
  readonly close?: () => Promise<void>;
}

/** A {@link StreamingSource} over a built out-of-core tile store. */
export class OlvTileSource implements StreamingSource {
  readonly id: string;
  readonly kind = 'tiles' as const;
  readonly name: string;
  /** The recentring origin the build stored — world = local + this. */
  readonly renderOrigin: [number, number, number];
  /**
   * The source-to-render conversion. A recentring with no rotation: this format
   * is LAS-derived and Z-up, so render up is the source's own +Z.
   */
  readonly frame: SpatialFrame;

  readonly octree: OlvTileOctree;

  private readonly _store: TileStoreReader;
  private readonly _tiles: TileBytesReader;
  private readonly _crs: CrsInfo | null;
  private readonly _close: (() => Promise<void>) | undefined;

  constructor(options: OlvTileSourceOptions) {
    this.id = options.id;
    this.name = options.name;
    this._store = options.store;
    this._tiles = options.tiles;
    this._crs = options.crs ?? null;
    this._close = options.close;
    const o = options.store.manifest.origin;
    this.renderOrigin = [o[0], o[1], o[2]];
    this.frame = createTranslatedFrame(this.renderOrigin);
    this.octree = new OlvTileOctree(options.store);
  }

  get sourcePointCount(): number {
    return this._store.manifest.pointCount;
  }

  get residentPointCount(): number {
    return this.octree.store.residentPointCount;
  }

  counts(): NodeCounts {
    return this.octree.store.counts();
  }

  maxDepth(): number {
    let depth = 0;
    for (const node of this.octree.nodes()) {
      if (node.record.key.depth > depth) depth = node.record.key.depth;
    }
    return depth;
  }

  /**
   * The octree root cube in LOCAL render space — equal-sided, for framing the
   * camera. The manifest stores the cube already recentred, so this is the
   * stored figure unshifted; the node records carry the world form.
   */
  localBounds(): Box6 {
    const { min, size } = this._store.manifest.root;
    return [min[0], min[1], min[2], min[0] + size, min[1] + size, min[2] + size];
  }

  /** The tight data extent the build measured in its bounds pass, local like
   * {@link localBounds}. */
  dataBounds(): Box6 {
    const { min, max } = this._store.manifest.bounds;
    return [min[0], min[1], min[2], max[0], max[1], max[2]];
  }

  defaultColorMode(): StreamingColorMode {
    return this._store.schema.hasRgb ? 'rgb' : 'elevation';
  }

  /**
   * Every tile record carries intensity and classification by layout, so those
   * two and elevation are always drivable; colour depends on whether the source
   * had any.
   */
  /**
   * The build wrote a GPS time field only when its source carried one, so the
   * manifest schema is the answer rather than a property of the format.
   */
  hasGpsTime(): boolean {
    return this._store.schema.hasGps;
  }

  availableColorModes(): readonly StreamingColorMode[] {
    const out: StreamingColorMode[] = [];
    if (this._store.schema.hasRgb) out.push('rgb');
    out.push('intensity', 'elevation', 'classification');
    return out;
  }

  crs(): CrsInfo | null {
    return this._crs;
  }

  async readNodeChunk(record: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    const bytes = await this._tiles.read(tileKeyOf(record.id), signal);
    signal?.throwIfAborted();
    // The scheduler transfers the buffer to a worker, so hand it one that owns
    // its bytes: a subarray view would transfer the whole backing store with it.
    return bytes.slice().buffer;
  }

  /**
   * A tile is stored decoded, so the only field the tile decoder reads is the
   * point count. The LAS-shaped fields describe that honestly: the record length
   * is the real one from the manifest, the scale and offset are the identity
   * transform the decoder actually applies, and the point-data-record format is
   * `-1` because a tile record is not a LAS point record and must not be read as
   * PDRF 0. The render origin here is zero rather than {@link renderOrigin}:
   * this field is the shift the DECODER still has to apply, and the build
   * already applied it.
   */
  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata {
    return {
      pointDataRecordFormat: -1,
      pointRecordLength: this._store.recordBytes,
      pointCount: record.pointCount,
      scale: [1, 1, 1],
      offset: [0, 0, 0],
      renderOrigin: [0, 0, 0],
      // Build-time colour was already narrowed to 8-bit, so there is no
      // per-cloud bit-depth decision left for the first chunk to make.
      rgbEightBit: this._store.schema.hasRgb ? true : undefined,
    };
  }

  async close(): Promise<void> {
    await this._close?.();
  }
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * PreviewCloudSource — a stratified sample as a lightweight streaming source.
 *
 * Co-located with {@link OlvTileSource} because it is the same kind of adapter:
 * tile records presented as a {@link StreamingSource} over a single
 * {@link StreamingNodeStore}. Keeping it here reuses that one io->render value
 * edge rather than opening a second one from a new file (the module-graph
 * ratchet is shrink-only). The heavy out-of-core build blocks for a long time on
 * a multi-gigabyte file; {@link buildPreviewSample} reads a bounded, spatially
 * spread SAMPLE, and this wraps it so it attaches through the exact same
 * `attachStreamingCloud` path the real source uses and renders immediately.
 *
 * It is deliberately a SINGLE-LEVEL cloud: one root node holding every sampled
 * record, decoded once through the shared {@link TileChunkDecoder}. It exists
 * only until the full index replaces it, so there is no hierarchy to refine.
 *
 * HONESTY. A preview must never be mistaken for the complete cloud:
 *  - {@link PreviewCloudSource.sourcePointCount} is the SAMPLE size, not the
 *    file's declared count, so every count a report or the Inspector derives is
 *    the number of points actually on screen.
 *  - the octree's `isComplete` is false, with a recorded reason, so the
 *    full-cloud grade and any completeness-sensitive consumer refuse to present
 *    the sample as a finished scan through the shared capability model.
 * The framing figures come from the file's own header extent, so the camera
 * frames the whole scene the sample is spread across.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** The single root node's id — the tile-key prefix keeps it distinct in logs. */
const PREVIEW_NODE_ID = 'p';

/** The reason a preview's octree records for being incomplete, so no consumer
 *  reads a sampled view as a whole cloud. */
export const PREVIEW_INCOMPLETE_REASON =
  'preview sample: a spread of the cloud, the full index is still building';

/**
 * A one-node octree over the sample. `isComplete` is false by construction: this
 * is a sample, never the whole cloud, and the recorded reason says so.
 */
class PreviewOctree implements StreamingOctreeView {
  readonly store = new StreamingNodeStore();
  readonly errors: readonly string[] = [PREVIEW_INCOMPLETE_REASON];
  readonly isComplete = false;

  constructor(bounds: Box6, pointCount: number, spacing: number) {
    this.store.add({
      id: PREVIEW_NODE_ID,
      key: { depth: 0, x: 0, y: 0, z: 0 },
      depth: 0,
      bounds,
      pointCount,
      byteOffset: 0,
      byteSize: 0,
      spacing,
      refine: 'replace',
    });
  }

  nodes() {
    return this.store.all();
  }
}

export interface PreviewCloudSourceOptions {
  readonly id: string;
  readonly name: string;
  readonly sample: PreviewSample;
  readonly crs?: CrsInfo | null;
}

/** A {@link StreamingSource} over a bounded, stratified preview sample. */
export class PreviewCloudSource implements StreamingSource {
  readonly id: string;
  readonly kind = 'tiles' as const;
  readonly name: string;
  readonly renderOrigin: [number, number, number];
  readonly frame: SpatialFrame;
  readonly octree: PreviewOctree;

  private readonly _sample: PreviewSample;
  private readonly _crs: CrsInfo | null;
  private readonly _localCube: Box6;

  constructor(options: PreviewCloudSourceOptions) {
    this.id = options.id;
    this.name = options.name;
    this._sample = options.sample;
    this._crs = options.crs ?? null;
    const o = options.sample.origin;
    this.renderOrigin = [o[0], o[1], o[2]];
    this.frame = createTranslatedFrame(this.renderOrigin);

    // An equal-sided cube over the file's data extent, for framing the camera.
    const { localMin, localMax } = options.sample;
    const size = Math.max(
      1e-3,
      localMax[0] - localMin[0],
      localMax[1] - localMin[1],
      localMax[2] - localMin[2],
    );
    const cx = (localMin[0] + localMax[0]) / 2;
    const cy = (localMin[1] + localMax[1]) / 2;
    const cz = (localMin[2] + localMax[2]) / 2;
    const half = size / 2;
    this._localCube = [cx - half, cy - half, cz - half, cx + half, cy + half, cz + half];
    // Node bounds are WORLD (local cube + origin): the scheduler subtracts
    // `renderOrigin` from them to reach render space, so they must start in the
    // frame the origin is expressed in. See OlvTileSource's frames note.
    const worldBounds: Box6 = [
      this._localCube[0] + o[0],
      this._localCube[1] + o[1],
      this._localCube[2] + o[2],
      this._localCube[3] + o[0],
      this._localCube[4] + o[1],
      this._localCube[5] + o[2],
    ];
    this.octree = new PreviewOctree(worldBounds, options.sample.pointCount, size);
  }

  /** THE SAMPLE SIZE — never the file's declared count. See the class note. */
  get sourcePointCount(): number {
    return this._sample.pointCount;
  }

  get residentPointCount(): number {
    return this.octree.store.residentPointCount;
  }

  counts(): NodeCounts {
    return this.octree.store.counts();
  }

  maxDepth(): number {
    return 0;
  }

  localBounds(): Box6 {
    return [...this._localCube];
  }

  dataBounds(): Box6 {
    const { localMin, localMax } = this._sample;
    return [localMin[0], localMin[1], localMin[2], localMax[0], localMax[1], localMax[2]];
  }

  defaultColorMode(): StreamingColorMode {
    return this._sample.schema.hasRgb ? 'rgb' : 'elevation';
  }

  availableColorModes(): readonly StreamingColorMode[] {
    const out: StreamingColorMode[] = [];
    if (this._sample.schema.hasRgb) out.push('rgb');
    out.push('intensity', 'elevation', 'classification');
    return out;
  }

  hasGpsTime(): boolean {
    return this._sample.schema.hasGps;
  }

  crs(): CrsInfo | null {
    return this._crs;
  }

  async readNodeChunk(_record: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> {
    signal?.throwIfAborted();
    // The scheduler transfers the buffer to a worker, so hand it a copy that
    // owns its bytes rather than a view over the retained sample.
    return this._sample.records.slice().buffer;
  }

  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata {
    return {
      pointDataRecordFormat: -1,
      pointRecordLength: this._sample.recordBytes,
      pointCount: record.pointCount,
      scale: [1, 1, 1],
      offset: [0, 0, 0],
      renderOrigin: [0, 0, 0],
      rgbEightBit: this._sample.schema.hasRgb ? true : undefined,
    };
  }

  async close(): Promise<void> {
    // In-memory: nothing to release.
  }
}
