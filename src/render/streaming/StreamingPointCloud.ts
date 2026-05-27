/**
 * StreamingPointCloud.ts
 *
 * The viewer-facing streaming cloud — the streaming analogue of the static
 * `PointCloud`. It owns the {@link CopcSource} and the {@link StreamingOctree},
 * picks the shared render origin, and exposes the metadata and live counts the
 * Inspector, the streaming panel, and the diagnostics overlay read.
 *
 * Pure of three.js; async only through the COPC range reads.
 */

import type { RangeSource } from '../../io/range/RangeSource';
import { CopcSource } from '../../io/copc/CopcSource';
import { StreamingOctree } from './StreamingOctree';
import type {
  CopcMetadata,
  Box6,
  StreamingNodeRecord,
} from '../../io/copc/copcTypes';
import type { ChunkDecodeMetadata } from '../../io/copc/copcChunkDecode';
import type { NodeCounts } from './StreamingNodeStore';
import type {
  StreamingSource,
  StreamingSourceKind,
} from './StreamingSource';

/** The render origin — the floored octree-cube centre, shared by every node. */
function pickRenderOrigin(
  center: [number, number, number],
): [number, number, number] {
  return [Math.floor(center[0]), Math.floor(center[1]), Math.floor(center[2])];
}

/**
 * An opened, hierarchy-loaded COPC cloud, ready for the scheduler to stream.
 *
 * v0.3.2: this class is the COPC implementation of the format-
 * agnostic {@link StreamingSource} interface. v0.3.3 will add a parallel
 * `EptStreamingSource` class; the scheduler / renderer / Viewer depend only
 * on the interface and don't need to change.
 */
export class StreamingPointCloud implements StreamingSource {
  /** Identifies this source as COPC-backed for the {@link StreamingSource} contract. */
  readonly kind: StreamingSourceKind = 'copc';
  readonly source: CopcSource;
  readonly octree: StreamingOctree;
  /** The render origin every node is recentred against (float64-stable). */
  readonly renderOrigin: [number, number, number];
  /** The display name — the file name. */
  readonly name: string;

  private constructor(
    source: CopcSource,
    octree: StreamingOctree,
    renderOrigin: [number, number, number],
    name: string,
  ) {
    this.source = source;
    this.octree = octree;
    this.renderOrigin = renderOrigin;
    this.name = name;
  }

  /**
   * Open a COPC cloud over a range source: read the metadata, load the whole
   * hierarchy index (not the point data), and pick the render origin.
   */
  static async open(
    range: RangeSource,
    name: string,
    signal?: AbortSignal,
  ): Promise<StreamingPointCloud> {
    const source = await CopcSource.open(range, signal);
    const octree = new StreamingOctree(source);
    await octree.loadFullHierarchy(signal);
    const renderOrigin = pickRenderOrigin(source.metadata.info.center);
    return new StreamingPointCloud(source, octree, renderOrigin, name);
  }

  /** The parsed COPC metadata. */
  get metadata(): CopcMetadata {
    return this.source.metadata;
  }

  /** Total points in the source file — not the displayed count. */
  get sourcePointCount(): number {
    return this.metadata.header.pointCount;
  }

  /** Points currently uploaded to the GPU. */
  get residentPointCount(): number {
    return this.octree.store.residentPointCount;
  }

  /** Live node counts by lifecycle state. */
  counts(): NodeCounts {
    return this.octree.store.counts();
  }

  /** The deepest octree level the hierarchy revealed. */
  maxDepth(): number {
    let depth = 0;
    for (const node of this.octree.nodes()) {
      if (node.record.key.depth > depth) depth = node.record.key.depth;
    }
    return depth;
  }

  /**
   * v0.3.3 — format-agnostic default colour mode. COPC clouds use RGB when
   * the point format carries it (PDRF 7 / 8), elevation otherwise.
   */
  defaultColorMode(): 'rgb' | 'intensity' | 'elevation' | 'classification' | 'normal' {
    return this.metadata.header.hasRgb ? 'rgb' : 'elevation';
  }

  /**
   * v0.3.3 — the colour modes a COPC cloud can drive. RGB only when
   * present; intensity / elevation / classification are always available
   * on COPC PDRF 6/7/8.
   */
  availableColorModes(): readonly ('rgb' | 'intensity' | 'elevation' | 'classification' | 'normal')[] {
    const out: ('rgb' | 'intensity' | 'elevation' | 'classification' | 'normal')[] = [];
    if (this.metadata.header.hasRgb) out.push('rgb');
    out.push('intensity', 'elevation', 'classification');
    return out;
  }

  /**
   * v0.3.3 — the CRS the COPC public-header parser pulled out of the
   * LASF_Projection VLRs (see `src/io/crs.ts`). Already cached on the
   * header; we re-expose it through the abstract `StreamingSource`
   * contract so the Viewer's export adapter doesn't need to peek at
   * COPC-specific metadata shapes.
   */
  crs(): import('../../io/crs').CrsInfo | null {
    return this.metadata.header.crs;
  }

  /**
   * The cloud's bounds in local (render) space — the octree cube shifted by
   * the render origin. The viewer uses this for framing.
   */
  localBounds(): Box6 {
    const { center, halfsize } = this.source.cube;
    const [rx, ry, rz] = this.renderOrigin;
    return [
      center[0] - halfsize - rx,
      center[1] - halfsize - ry,
      center[2] - halfsize - rz,
      center[0] + halfsize - rx,
      center[1] + halfsize - ry,
      center[2] + halfsize - rz,
    ];
  }

  /**
   * Read a node's compressed chunk from the COPC source. Implements
   * {@link StreamingSource.readNodeChunk}; the scheduler calls this through
   * the interface and never touches `CopcSource` directly.
   */
  readNodeChunk(
    record: StreamingNodeRecord,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    return this.source.readNodeChunk(record, signal);
  }

  /**
   * Build the decode metadata for one node. The scheduler hands this to the
   * decoder along with the compressed bytes. Implements
   * {@link StreamingSource.decodeMeta}; the COPC implementation pulls every
   * field from the parsed LAS header. An EPT implementation will produce
   * the same shape from its own metadata layout.
   */
  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata {
    const header = this.metadata.header;
    return {
      pointDataRecordFormat: header.pointDataRecordFormat,
      pointRecordLength: header.pointRecordLength,
      pointCount: record.pointCount,
      scale: header.scale,
      offset: header.offset,
      renderOrigin: this.renderOrigin,
    };
  }
}
