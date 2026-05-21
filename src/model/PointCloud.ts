import type { SourceFormat } from '../io/sniffFormat';

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
  readonly origin: [number, number, number];
  readonly sourceFormat: SourceFormat;
  readonly name: string;
  readonly declaredPointCount?: number;

  constructor(options: PointCloudOptions) {
    this.positions = options.positions;
    this.colors = options.colors;
    this.intensity = options.intensity;
    this.classification = options.classification;
    this.origin = options.origin;
    this.sourceFormat = options.sourceFormat;
    this.name = options.name;
    this.declaredPointCount = options.declaredPointCount;
  }

  /** Number of points: three position components per point. */
  get pointCount(): number {
    return this.positions.length / 3;
  }

  /** Compute the local-coordinate min/max bounds over all positions. */
  bounds(): { min: [number, number, number]; max: [number, number, number] } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const v = this.positions[i + axis];
        if (v < min[axis]) min[axis] = v;
        if (v > max[axis]) max[axis] = v;
      }
    }
    return { min, max };
  }
}
