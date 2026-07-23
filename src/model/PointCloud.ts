import type { SourceFormat } from '../io/sniffFormat';
import type { CrsInfo } from '../io/crs';

/**
 * One source-metadata field exactly as the file declared it. `value` is
 * verbatim; nothing here is inferred, normalised, or verified by the viewer.
 */
export interface DeclaredMetadataField {
  /** Local field name as declared, e.g. "sensorModel" or "datasetType". */
  readonly name: string;
  /** The declared value, verbatim. */
  readonly value: string;
  /** Namespace URI for extension-namespace fields (absent for standard fields). */
  readonly namespaceUri?: string;
}

/**
 * Declared-only source metadata recovered from the file (currently the E57
 * XML section). Two ordered lists: the format's standard provenance fields,
 * and extension-namespace fields the writer added (e.g. an `olv:` block).
 * Everything is DECLARED BY THE FILE, not verified by the viewer — surfaces
 * that render it must say so. No inference is ever mixed in.
 */
export interface SourceMetadata {
  readonly standard: readonly DeclaredMetadataField[];
  readonly extensions: readonly DeclaredMetadataField[];
}

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
   * True when the source asset carried a texture/material (glTF images or
   * materials), even though the loader keeps only vertex geometry. A decode
   * observation, not declared provenance — used by the display profile to
   * treat a textured, object-scale mesh as a handheld/object capture rather
   * than a bare mesh.
   */
  hasTexture?: boolean;
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
  /**
   * Declared-only source metadata read from the file itself (standard +
   * extension-namespace fields, ordered). Declared, not verified — display
   * surfaces must carry that qualifier. Absent when the file declares
   * nothing beyond geometry.
   */
  sourceMetadata?: SourceMetadata;
  /**
   * The file's own capture statement, precomputed at load time from
   * `sourceMetadata` (see `diagnostics/declaredCapture.ts`) when the
   * declared fields state a synthetic / procedural / reconstruction /
   * reference origin — including the pre-built display strings, so the
   * startup shell carries none of the wording. The capture-type classifier
   * quotes it verbatim and demotes its heuristics; absent for files that
   * declare nothing.
   */
  declaredCapture?: {
    readonly field: string;
    readonly value: string;
    readonly label: string;
    readonly signal: string;
    readonly disclaimer: string;
  };
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
  /**
   * v0.5.5 P12 — the decode stride the loader DELIBERATELY applied (the
   * budget-aware display-sample cap decodes one record per bucket of
   * `loadStride`). 1 / undefined = every record was read. Kept so the
   * Health Check can distinguish "decoded < declared because of the
   * display-sample cap" (informational) from "decode genuinely lost
   * points" (a real anomaly). Survives voxel downsampling.
   */
  loadStride?: number;
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
  /**
   * The world-space origin subtracted from the positions at load time.
   *
   * This never moves after construction. The in-place rebase that used to
   * rewrite it (and the Float32 buffer with it) is retired: mounting into a
   * shared project frame is now a Float64 placement held BESIDE the cloud
   * (`LayerSpatialTransform`, applied by the viewer per mesh and by
   * `projectXYZ` per read — see docs/architecture/float64-transform.md), so
   * `origin` and {@link sourceOrigin} stay equal for the object's life.
   * `origin` remains only because legacy call sites read it; new code names
   * the frame it means and uses `sourceOrigin` (`lint:position-access` holds
   * that surface).
   */
  readonly origin: [number, number, number];
  /**
   * The origin this cloud was LOADED with, fixed for the object's life.
   *
   * Project membership has to be reversible — a layer can have its
   * CRS overridden to something incompatible, be dropped from the frame,
   * moved to another project, exported in source coordinates, restored from a
   * session, or audited against its file — and every one of those needs the
   * frame the file actually declared, not the frame it currently sits in.
   */
  readonly sourceOrigin: readonly [number, number, number];
  readonly sourceFormat: SourceFormat;
  readonly name: string;
  readonly declaredPointCount?: number;
  readonly decodedPointCount?: number;
  readonly loadStride?: number;
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
    // A COPY, deliberately. Nothing in this class writes either origin any
    // more, but the caller still holds a reference to its own array — a copy
    // keeps the record that exists to outlive the caller from being writable
    // through it.
    this.sourceOrigin = [options.origin[0], options.origin[1], options.origin[2]];
    this.sourceFormat = options.sourceFormat;
    this.name = options.name;
    this.declaredPointCount = options.declaredPointCount;
    this.decodedPointCount = options.decodedPointCount;
    this.loadStride = options.loadStride;
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
   * The world coordinate of point `index`, as `positions[index] + sourceOrigin`.
   *
   * Both terms are fixed at construction and nothing rewrites either
   * (float64-transform.md invariant 2), so this holds for the object's life —
   * mounted or not. Placement into a project frame is data ABOUT the layer
   * and never enters this sum; the project-frame lift is {@link projectXYZ}.
   *
   * Pass `out` to avoid allocating a tuple per point in a hot loop.
   */
  worldXYZ(
    index: number,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    const base = index * 3;
    if (index < 0 || base + 2 >= this.positions.length) {
      throw new RangeError(`worldXYZ: index ${index} out of range for ${this.positions.length / 3} points`);
    }
    out[0] = this.positions[base] + this.sourceOrigin[0];
    out[1] = this.positions[base + 1] + this.sourceOrigin[1];
    out[2] = this.positions[base + 2] + this.sourceOrigin[2];
    return out;
  }

  /**
   * The project-local coordinate of point `index` under a layer transform:
   * source-local position plus the Float64 `sourceToProject` translation,
   * computed at read time. The buffer is never written
   * (docs/architecture/float64-transform.md), so with the identity transform
   * — the single-layer case — this is bit-identical to the raw source-local
   * position, which is what made each consumer migration onto it a provable
   * no-op, and setting then clearing a transform cannot lose anything:
   * nothing was re-quantised.
   *
   * Takes the transform as an argument rather than storing it: placement is
   * data ABOUT the layer, owned by the project frame, and a cloud must not
   * carry a second copy that can drift from it.
   *
   * Pass `out` to avoid allocating a tuple per point in a hot loop.
   */
  projectXYZ(
    index: number,
    transform: { readonly sourceToProject: readonly [number, number, number] },
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    const base = index * 3;
    if (index < 0 || base + 2 >= this.positions.length) {
      throw new RangeError(`projectXYZ: index ${index} out of range for ${this.positions.length / 3} points`);
    }
    out[0] = this.positions[base] + transform.sourceToProject[0];
    out[1] = this.positions[base + 1] + transform.sourceToProject[1];
    out[2] = this.positions[base + 2] + transform.sourceToProject[2];
    return out;
  }

  /**
   * The worst-case Float32 step size this cloud's coordinates would land on
   * if its positions were rewritten onto `target`, in source units, split by
   * axis group.
   *
   * The in-place rewrite this models is RETIRED — mounting is a Float64
   * placement that never touches the buffer (float64-transform.md) — but the
   * mount-refusal gates in LayerService still read this figure as a
   * conservative admission rule: a mount that would have cost more than a
   * millimetre under the old mechanism is still refused, until step 6
   * (browser verification of two-layer placement) revisits the gates along
   * with `MULTI_LAYER_MOUNT_ENABLED`.
   *
   * The model: positions are Float32, so an offset written into them spends
   * mantissa the residual was using. The cost is set by how far the layer
   * moves plus its own extent — NOT by the absolute coordinate — so a lone
   * georeferenced scan anchored on its own origin pays nothing, while layers
   * 100 km apart give up a millimetre.
   *
   * Horizontal (worst of X/Y) and vertical (Z) are reported SEPARATELY because
   * a compound CRS measures them in different units — feet across, metres up.
   * Collapsing them to one worst number left the caller converting a Z step
   * through the horizontal unit: on feet-over-metres a 1.95 mm height error
   * read as 0.6 mm and passed a gate named for a millimetre.
   */
  rebaseQuantum(target: readonly [number, number, number]): {
    horizontal: number;
    vertical: number;
  } {
    const b = this.bounds();
    const stepOn = (a: number): number => {
      const shift = this.origin[a] - target[a];
      const reach = Math.max(Math.abs(b.min[a] + shift), Math.abs(b.max[a] + shift));
      // Float32 carries a 24-bit significand: the step at magnitude m is
      // 2^(floor(log2 m) - 23). Zero magnitude has no step to speak of.
      return reach > 0 ? 2 ** (Math.floor(Math.log2(reach)) - 23) : 0;
    };
    return {
      horizontal: Math.max(stepOn(0), stepOn(1)),
      vertical: stepOn(2),
    };
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
