import type { SourceFormat } from '../io/sniffFormat';

/**
 * Provenance metadata recovered from a file header, when the format carries
 * it. Every field is optional — most scan files fill in only some, or none.
 */
export interface CloudMetadata {
  /** Capture hardware or sensor, e.g. the LAS System Identifier field. */
  captureSensor?: string;
  /** Software that produced the file, e.g. the LAS Generating Software field. */
  sourceSoftware?: string;
  /** Human-readable capture / file-creation date. */
  captureDate?: string;
  /**
   * The scanner's registered world position, when the format records it (the
   * PTX per-scan transform). Real-world coordinates, before the load-time
   * origin shift.
   */
  scannerOrigin?: [number, number, number];
}

/** Options accepted by the `PointCloud` constructor. */
export interface PointCloudOptions {
  /** Interleaved xyz positions in local (recentered) coordinates. */
  positions: Float32Array;
  /** Optional interleaved rgb color, one byte per channel. */
  colors?: Uint8Array;
  /** Optional per-point intensity. */
  intensity?: Uint16Array;
  /** Optional per-point ASPRS classification code. */
  classification?: Uint8Array;
  /** Optional interleaved per-point normal vectors (xyz). */
  normals?: Float32Array;
  /** Optional per-point LAS return number (which return of a pulse this is). */
  returnNumber?: Uint8Array;
  /** Optional per-point LAS number of returns for the originating pulse. */
  returnCount?: Uint8Array;
  /** Optional per-point LAS point source ID (the originating flight line). */
  pointSourceId?: Uint16Array;
  /** Optional per-point LAS GPS time, in the file's GPS-time encoding. */
  gpsTime?: Float64Array;
  /** The integer world-space origin that was subtracted from the positions. */
  origin: [number, number, number];
  /** Which file format this cloud was loaded from. */
  sourceFormat: SourceFormat;
  /** Display name (usually the source filename). */
  name: string;
  /**
   * The point count the source file's header declared. Kept so a later
   * integrity check can compare it against the actually-loaded count.
   */
  declaredPointCount?: number;
  /**
   * The point count actually decoded from the file, before any downsampling.
   * Survives voxel downsampling so the Health Check compares the file's
   * declared count against what was decoded — not against the reduced count.
   */
  decodedPointCount?: number;
  /** Provenance metadata read from the file header, when available. */
  metadata?: CloudMetadata;
}

/**
 * In-memory representation of a loaded point cloud.
 *
 * Pure data: no rendering, no parsing. Positions are stored in local
 * coordinates; `origin` records the world-space shift that produced them.
 */
export class PointCloud {
  readonly positions: Float32Array;
  readonly colors?: Uint8Array;
  readonly intensity?: Uint16Array;
  readonly classification?: Uint8Array;
  readonly normals?: Float32Array;
  readonly returnNumber?: Uint8Array;
  readonly returnCount?: Uint8Array;
  readonly pointSourceId?: Uint16Array;
  readonly gpsTime?: Float64Array;
  readonly origin: [number, number, number];
  readonly sourceFormat: SourceFormat;
  readonly name: string;
  readonly declaredPointCount?: number;
  readonly decodedPointCount?: number;
  readonly metadata?: CloudMetadata;

  /**
   * Cached min/max bounds. Positions are immutable, so the O(n) scan in
   * `bounds()` runs at most once — it is otherwise repeated several times per
   * load (framing, the Scan Report, the project card).
   */
  private _bounds: {
    min: [number, number, number];
    max: [number, number, number];
  } | null = null;

  constructor(options: PointCloudOptions) {
    this.positions = options.positions;
    this.colors = options.colors;
    this.intensity = options.intensity;
    this.classification = options.classification;
    this.normals = options.normals;
    this.returnNumber = options.returnNumber;
    this.returnCount = options.returnCount;
    this.pointSourceId = options.pointSourceId;
    this.gpsTime = options.gpsTime;
    this.origin = options.origin;
    this.sourceFormat = options.sourceFormat;
    this.name = options.name;
    this.declaredPointCount = options.declaredPointCount;
    this.decodedPointCount = options.decodedPointCount;
    this.metadata = options.metadata;
  }

  /** Number of points: three position components per point. */
  get pointCount(): number {
    return this.positions.length / 3;
  }

  /**
   * The local-coordinate min/max bounds over all positions.
   *
   * The scan is computed once and cached; each call returns a fresh copy, so a
   * caller can never corrupt the cached value.
   */
  bounds(): { min: [number, number, number]; max: [number, number, number] } {
    if (this._bounds === null) {
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < this.positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const v = this.positions[i + axis];
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
        }
      }
      this._bounds = { min, max };
    }
    const { min, max } = this._bounds;
    return {
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
    };
  }
}
