/**
 * copcTypes.ts
 *
 * Pure shared types for the COPC streaming pipeline — the metadata a preflight
 * produces, the octree node records a hierarchy parse produces, and the small
 * geometry types they need. No DOM, no three.js, no I/O.
 */

/** An octree voxel key — depth and integer cell coordinates within that depth. */
export interface VoxelKey {
  depth: number;
  x: number;
  y: number;
  z: number;
}

/** An axis-aligned box, `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export type Box6 = [number, number, number, number, number, number];

/**
 * The COPC octree cube — centre and half-side. This is the *normative* octree
 * definition from the COPC `info` VLR; all node bounds derive from it (not from
 * the LAS header's tight data bounds, which depend on writer convention).
 */
export interface OctreeCube {
  center: [number, number, number];
  halfsize: number;
}

/** The COPC `info` VLR — the octree's defining parameters. */
export interface CopcInfo {
  center: [number, number, number];
  halfsize: number;
  /** Point spacing at the root node; halved per octree level. */
  spacing: number;
  /** File offset of the root hierarchy page. */
  rootHierOffset: number;
  /** Size of the root hierarchy page, in bytes (a multiple of 32). */
  rootHierSize: number;
  gpsTimeRange: [number, number];
}

/** The LAS 1.4 header facts the COPC pipeline needs. */
export interface CopcHeaderInfo {
  /** Point data record format — 6, 7, or 8 for a COPC file. */
  pointDataRecordFormat: number;
  pointRecordLength: number;
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  /** Tight data bounds minimum, `[minX, minY, minZ]`. */
  min: [number, number, number];
  /** Tight data bounds maximum, `[maxX, maxY, maxZ]`. */
  max: [number, number, number];
  /** True when the point format carries RGB (PDRF 7 or 8). */
  hasRgb: boolean;
  /** True when the point format carries GPS time (all of 6, 7, 8 do). */
  hasGpsTime: boolean;
  /**
   * CRS parsed from the LASF_Projection VLR(s) at the head
   * of the COPC file. `null` when the file carries no projection metadata
   * (rare for COPC — they're typically georeferenced surveys). Drives the
   * Scan Intelligence CRS row, the scan-report card, and the measurement
   * tool's metres-vs-feet unit conversion.
   */
  crs: import('../crs').CrsInfo | null;
}

/** The combined COPC metadata produced by the cheap preflight. */
export interface CopcMetadata {
  header: CopcHeaderInfo;
  info: CopcInfo;
}

/**
 * An immutable octree node record, as parsed from a COPC hierarchy page.
 * Runtime streaming state (loading / resident / evicted) lives on the separate
 * runtime `StreamingNode`, never here.
 */
export interface StreamingNodeRecord {
  /** Deterministic id — the string `"depth-x-y-z"`. */
  id: string;
  key: VoxelKey;
  /** Node bounds, derived from the COPC octree cube. */
  bounds: Box6;
  /** Number of points in this node's chunk. */
  pointCount: number;
  /** File offset of the LAZ-compressed chunk. */
  byteOffset: number;
  /** Compressed size of the chunk, in bytes. */
  byteSize: number;
  /** Point spacing at this node's depth. */
  spacing: number;
  /** Id of the parent node, when known. */
  parentId?: string;
}

/** A reference to a child hierarchy page (an entry with `pointCount === -1`). */
export interface ChildPageRef {
  key: VoxelKey;
  /** File offset of the child page. */
  pageOffset: number;
  /** Size of the child page, in bytes. */
  pageSize: number;
}
