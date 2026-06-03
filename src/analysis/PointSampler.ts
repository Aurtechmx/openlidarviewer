/**
 * PointSampler.ts
 *
 * The single architectural seam every analysis feature consumes. Cloud
 * implementations (static, streaming COPC, streaming EPT) provide a
 * `PointSampler`; analysis functions read points exclusively through this
 * interface.
 *
 * The full contract lives in `docs/analysis-architecture.md`. Critical
 * rules summarised here:
 *
 *   - The sampler is read-only. Analyses never mutate cloud state.
 *   - A streaming sampler reports `coverage: 'resident-only'` and the UI
 *     MUST surface that distinction wherever the output is exported,
 *     shared, or screenshotted.
 *   - Iteration observes a snapshot of the resident set at call time; nodes
 *     loaded mid-iteration are not visible to that call.
 *   - Analyses get a budget at most equal to the renderer's point budget;
 *     above the budget, the analysis returns a truncated result with
 *     `truncated: true` OR throws `BudgetExceededError` before allocating.
 *   - Long analyses (> 100 ms est) accept an `AbortSignal` and discard
 *     partial state on cancellation.
 *   - Results are deterministic functions of
 *     `(cloudId, params, coverage, residentNodesHash)`; the runner may
 *     cache and return on a matching key.
 *
 * Sampler implementations and the `AnalysisRunner` are out of scope for
 * this release. This file defines the interface, the supporting types,
 * and the error class surface so current callers (the Scan Quality Audit,
 * the Provenance panel) can compile against the contract without
 * implementing it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate + bounds primitives
// ─────────────────────────────────────────────────────────────────────────────

/** A coordinate triple in render space (local to the loaded cloud). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Axis-aligned bounding box: `[minX, minY, minZ, maxX, maxY, maxZ]`.
 *
 * Tuple form chosen to match the rest of the codebase (`localBoundsAabb`,
 * `Cloud.bounds`, etc.) and to avoid extra allocation in hot iteration.
 */
export type AABB = readonly [number, number, number, number, number, number];

// ─────────────────────────────────────────────────────────────────────────────
// Per-point attributes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-point attribute payload the iteration callback receives. Every field
 * is optional — the iteration delivers what the sampler can supply.
 *
 * The reduced surface (six channels rather than the full LAS-extended set)
 * is intentional: it covers every attribute every shipped analysis needs,
 * and stays cheap enough that the per-callback allocation overhead is
 * negligible.
 */
export interface PointAttributes {
  /** Per-point colour, 0-1 per channel. */
  readonly rgb?: readonly [number, number, number];
  /** Raw LiDAR intensity (sensor-native units). */
  readonly intensity?: number;
  /** ASPRS classification code (0-31 standard, higher = user-defined). */
  readonly classification?: number;
  /** LAS return number (1 = first return). */
  readonly returnNumber?: number;
  /** LAS total returns for this pulse. */
  readonly numberOfReturns?: number;
  /** Adjusted GPS time, if present in the source format. */
  readonly gpsTime?: number;
}

/**
 * The callback shape every iteration accepts.
 *
 * Coordinates are unpacked from any internal Float32 / Float64 storage
 * into the three first arguments to avoid per-point allocation. Attributes
 * arrive as a single object whose fields are populated only when present.
 */
export type PointCallback = (
  x: number,
  y: number,
  z: number,
  attributes: PointAttributes,
) => void;

// ─────────────────────────────────────────────────────────────────────────────
// Sampler interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Indicates whether the sampler can iterate the entire dataset or only the
 * subset currently resident in memory.
 *
 * - `'full'` — all source points are reachable. Used by static clouds.
 * - `'resident-only'` — only points in currently-resident streaming nodes
 *   are reachable. Used by COPC + EPT samplers. The UI MUST surface this
 *   distinction whenever the analysis output is exported, shared, or
 *   screenshotted.
 */
export type SamplerCoverage = 'full' | 'resident-only';

/**
 * The single seam every cloud exposes and every analysis consumes.
 *
 * Implementations live in `src/analysis/StaticPointSampler.ts` and
 * `src/analysis/StreamingPointSampler.ts`. Consumers must never
 * import a concrete cloud type to read points — the sampler is the only
 * legal path.
 */
export interface PointSampler {
  /**
   * Whether this sampler covers the entire dataset (`'full'`) or only the
   * subset currently resident in memory (`'resident-only'`).
   *
   * Streaming samplers ALWAYS report `'resident-only'`, even when every
   * node happens to be resident — the rule is structural, not statistical.
   * The streaming pipeline can evict at any time; an analysis must never
   * assume "I saw everything" from a streaming source.
   */
  readonly coverage: SamplerCoverage;

  /**
   * Number of points the sampler can actually iterate right now. For
   * `'full'` coverage this equals `sourcePointCount`. For `'resident-only'`
   * coverage this is the count of points in currently-resident nodes,
   * typically much smaller than the source dataset.
   */
  readonly availablePointCount: number;

  /**
   * Total point count claimed by the source dataset. For streaming sources
   * this is the manifest-declared count; for static clouds this equals
   * `availablePointCount`.
   *
   * Surfaced to the user as the denominator in the coverage indicator:
   * *"analysing N of M points"*.
   */
  readonly sourcePointCount: number;

  /**
   * Stable identifier for the underlying source cloud. Used by the
   * `AnalysisRunner` as part of the deterministic cache key — see
   * `docs/analysis-architecture.md` §6.
   *
   * Typically the runtime cloud ID (`viewer.activeCloudId()` for static,
   * `cloud.name` for streaming). Stable across the lifetime of the loaded
   * cloud.
   */
  readonly sourceCloudId: string;

  /**
   * Iterate every available point in unspecified order.
   *
   * Snapshot semantics: the resident set is captured at call entry; nodes
   * that load mid-iteration are NOT seen by this call.
   */
  forEach(callback: PointCallback): void;

  /**
   * Iterate every available point inside the closed-lower / open-upper
   * AABB in unspecified order.
   *
   * Closed lower / open upper bounds match standard spatial-bin
   * conventions and avoid double-counting on grid cell edges.
   */
  forEachInBox(aabb: AABB, callback: PointCallback): void;

  /**
   * Iterate every available point inside the prism formed by extruding the
   * 2D polygon `polygon` vertically between `zMin` and `zMax`.
   *
   * The polygon's XY components are used; the Z component is ignored.
   * The polygon MUST be closed (last vertex implicitly connects to the
   * first) and SHOULD be simple (non-self-intersecting); behaviour on
   * self-intersecting polygons is implementation-defined but MUST NOT
   * throw.
   */
  forEachInPrism(
    polygon: readonly Vec3[],
    zMin: number,
    zMax: number,
    callback: PointCallback,
  ): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown by an analysis whose output would exceed the runtime budget,
 * BEFORE any large allocation. The runner catches this, surfaces a clear
 * message to the caller, and does NOT populate the cache.
 *
 * See `docs/analysis-architecture.md` §4 + Contract C5.
 */
export class BudgetExceededError extends Error {
  readonly analysisName: string;
  readonly estimatedSize: number;
  readonly budget: number;

  constructor(analysisName: string, estimatedSize: number, budget: number) {
    super(
      `Analysis "${analysisName}" would allocate ${estimatedSize.toLocaleString()} ` +
      `points, exceeding the runtime budget of ${budget.toLocaleString()}. ` +
      `Reduce the parameter range or run against a smaller region of interest.`,
    );
    this.name = 'BudgetExceededError';
    this.analysisName = analysisName;
    this.estimatedSize = estimatedSize;
    this.budget = budget;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis result envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common envelope every analysis returns. Wraps the analysis-specific
 * payload with the coverage and truncation metadata the UI surfaces.
 *
 * The envelope is intentionally minimal — analyses are pure functions of
 * their inputs, and any metadata the UI needs lives here so the consumer
 * never needs to know the analysis-specific type to surface a warning.
 */
export interface AnalysisResult<T> {
  /** The analysis-specific payload. */
  readonly payload: T;
  /** The coverage of the sampler the analysis read from. */
  readonly coverage: SamplerCoverage;
  /** Number of points the analysis actually saw. */
  readonly observedPointCount: number;
  /** Source dataset's declared total point count. */
  readonly sourcePointCount: number;
  /**
   * True iff the analysis output was truncated to fit the runtime budget.
   * Consumers MUST surface this when true; see Contract C5 + §3 of the
   * architecture document.
   */
  readonly truncated: boolean;
  /** Wall time the analysis took, in milliseconds. */
  readonly elapsedMs: number;
}
