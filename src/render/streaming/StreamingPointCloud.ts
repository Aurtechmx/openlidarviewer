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
import type { CopcMetadata, Box6 } from '../../io/copc/copcTypes';
import type { NodeCounts } from './StreamingNodeStore';

/** The render origin — the floored octree-cube centre, shared by every node. */
function pickRenderOrigin(
  center: [number, number, number],
): [number, number, number] {
  return [Math.floor(center[0]), Math.floor(center[1]), Math.floor(center[2])];
}

/** An opened, hierarchy-loaded COPC cloud, ready for the scheduler to stream. */
export class StreamingPointCloud {
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
}
