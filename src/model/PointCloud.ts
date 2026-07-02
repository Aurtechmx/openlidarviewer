import type { SourceFormat } from '../io/sniffFormat';
import type { CrsInfo } from '../io/crs';

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
  /**
   * Coordinate Reference System recovered from the source file's headers
   * (LAS VLRs for LAS / LAZ / COPC; other formats are CRS-blind today).
   * `null` / undefined means CRS unknown — the viewer treats coordinates as
   * a generic local space and skips unit conversion. Research-grade users
   * rely on this for distance-in-true-metres and CRS provenance display.
   */
  crs?: CrsInfo | null;
  /**
   * Non-fatal anomalies the loader worked around rather than failing on —
   * e.g. an E57 scan skipped because it carries no Cartesian X/Y/Z, or a
   * pose quaternion that had to be normalised. Recorded here (and surfaced
   * in the Scan Report) so a partially-loaded file is never presented as a
   * cleanly-loaded one.
   */
  loadWarnings?: readonly string[];
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
  /**
   * Per-point ASPRS classification, backed privately so the only way to set it
   * after construction is {@link attachDerivedClassification} — which also
   * records that the codes are DERIVED (a heuristic), never confusing them with
   * a producer's classification. The public getter keeps the read API identical
   * to the former public field. Array CONTENTS stay mutable for the in-place
   * class editor (swap / polygon reclassify).
   */
  private _classification?: Uint8Array;
  private _classificationDerived = false;
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
    // Validate attribute lengths up front. A misaligned attribute array does
    // not crash — it silently maps the wrong colour / class / return / intensity
    // to each point and corrupts everything downstream (render, export, volume).
    // Reject it at the boundary instead, the same contract
    // `attachDerivedClassification` already enforces post-construction.
    const posLen = options.positions.length;
    if (posLen % 3 !== 0) {
      throw new Error(`PointCloud: positions length ${posLen} is not divisible by 3`);
    }
    const count = posLen / 3;
    const expectLength = (
      attr: string,
      value: ArrayLike<number> | undefined,
      expected: number,
    ): void => {
      if (value && value.length !== expected) {
        throw new Error(
          `PointCloud: ${attr} length ${value.length} does not match ${expected} ` +
            `(${count} points) — attribute arrays would misalign to points.`,
        );
      }
    };
    expectLength('colors', options.colors, count * 3);
    expectLength('normals', options.normals, count * 3);
    expectLength('intensity', options.intensity, count);
    expectLength('classification', options.classification, count);
    expectLength('returnNumber', options.returnNumber, count);
    expectLength('returnCount', options.returnCount, count);
    expectLength('pointSourceId', options.pointSourceId, count);
    expectLength('gpsTime', options.gpsTime, count);

    this.positions = options.positions;
    this.colors = options.colors;
    this.intensity = options.intensity;
    this._classification = options.classification;
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

  /** Per-point ASPRS classification (original from the file, or derived). */
  get classification(): Uint8Array | undefined {
    return this._classification;
  }

  /**
   * Whether the classification was DERIVED by the viewer's heuristic
   * classifier rather than read from the source file. Callers surface this so
   * derived codes are never presented as a producer's authoritative
   * classification (legend badge, export provenance).
   */
  get classificationIsDerived(): boolean {
    return this._classificationDerived;
  }

  /**
   * Attach a heuristic, derived classification to a cloud that had none (or
   * replace a prior derived one). Marks the cloud as carrying DERIVED codes.
   * Rejects a length mismatch rather than silently misaligning codes to points.
   */
  attachDerivedClassification(codes: Uint8Array): void {
    if (codes.length !== this.pointCount) {
      throw new Error(
        `attachDerivedClassification: ${codes.length} codes for ` +
          `${this.pointCount} points — length mismatch.`,
      );
    }
    this._classification = codes;
    this._classificationDerived = true;
  }

  /**
   * The local-coordinate min/max bounds over all positions.
   *
   * The scan is computed once and cached; each call returns a fresh copy, so a
   * caller can never corrupt the cached value.
   */
  bounds(): { min: [number, number, number]; max: [number, number, number] } {
    if (this._bounds === null) {
      // No points to span. A min/max reduction over zero elements would leave
      // the seeds at ±Infinity, and the half-open box that produces yields a
      // NaN centre and radius when a caller frames it. Return a finite,
      // degenerate box at the origin so every downstream consumer (camera
      // framing, bounding sphere) gets safe numbers. The parse pipeline already
      // rejects empty clouds; this is the defence in depth for any that slip
      // through (a streaming source, a programmatic construction).
      if (this.positions.length === 0) {
        this._bounds = { min: [0, 0, 0], max: [0, 0, 0] };
        return { min: [0, 0, 0], max: [0, 0, 0] };
      }
      const min: [number, number, number] = [Infinity, Infinity, Infinity];
      const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < this.positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const v = this.positions[i + axis];
          // Skip non-finite coordinates. A malformed binary file (PLY/PCD/E57)
          // or a bad reprojection can leave a ±Infinity: NaN is already ignored
          // by the comparisons below, but +Infinity > max sets max = Infinity and
          // blows the box out to infinity, making the camera frame to nothing.
          if (!Number.isFinite(v)) continue;
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
        }
      }
      // If an axis had no finite coordinate at all, its seed survives (±Infinity).
      // Collapse such an axis to a finite degenerate span so every downstream
      // consumer (framing, bounding sphere) still gets safe numbers.
      for (let axis = 0; axis < 3; axis++) {
        if (!Number.isFinite(min[axis]) || !Number.isFinite(max[axis])) {
          min[axis] = 0;
          max[axis] = 0;
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
