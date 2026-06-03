/**
 * TerrainContracts.ts
 *
 * The internal type contracts that every part of the terrain
 * intelligence subsystem speaks. Pure data: no DOM, no three.js, no
 * I/O — so the same shape names mean the same thing in the worker,
 * the cache, the engine, and any future UI surface.
 *
 * v0.3.9 ships these contracts WITHOUT any public UI. A future
 * release will surface ground classification, DTM / DSM, contours,
 * hillshade, slope maps, and height-above-ground on top of this
 * foundation — everything implements `TerrainAnalysisResult` so the
 * UI never has to special-case which producer it's reading.
 *
 * Honesty contract — EVERY result MUST carry:
 *   - `coverage`: did we analyse the full cloud, only resident
 *     streaming nodes, or a sampled subset?
 *   - `sourcePointCount`: how many points the input declared.
 *   - `analyzedPointCount`: how many points we actually walked.
 *   - `confidence`: a 0–100 summary the UI shows as a badge.
 *   - `warnings`: an ordered list of strings explaining any
 *     reduction in quality (e.g. "sampled — coverage 18%",
 *     "streaming resident-only — may refine as nodes stream in").
 *
 * Future terrain results MUST NOT imply full-cloud certainty when
 * only a partial set was analysed. The contract enforces that the
 * fields exist; the analyser populates them honestly.
 */

// ── coordinate primitives ──────────────────────────────────────────

/** A 3D point in scan-local coordinates. */
export interface TerrainPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Optional per-point index back into the source positions buffer. */
  readonly sourceIndex?: number;
}

/** A tile in a regular grid partition of the source cloud. */
export interface TerrainTile {
  /** Stable integer id — typically `tileY * tilesX + tileX`. */
  readonly id: number;
  /** Tile column in the grid (0-indexed). */
  readonly col: number;
  /** Tile row in the grid (0-indexed). */
  readonly row: number;
  /** Bounding box minimum in scan-local space. */
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  /** Bounding box maximum in scan-local space. */
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
  /** Point indices into the source positions buffer that fall in this tile. */
  readonly pointIndices: ReadonlyArray<number>;
}

/** A local neighborhood — what every metric reads from. */
export interface TerrainNeighborhood {
  /** Centre point — usually the query point itself. */
  readonly centre: TerrainPoint;
  /** Sample points within the neighborhood (centre excluded). */
  readonly samples: ReadonlyArray<TerrainPoint>;
  /** Effective neighborhood radius, in scan-local units. */
  readonly radius: number;
  /**
   * World up axis — defaults to `[0, 0, 1]` (Z-up). Override for
   * scans whose native frame is Y-up (some glTF / mobile sources)
   * so slope and HAG report against the correct vertical.
   */
  readonly worldUp?: readonly [number, number, number];
  /**
   * Linear-unit conversion to metres for the source CRS. Used by
   * variance, roughness, elevation range, and HAG so analyses
   * always report in metres regardless of the source unit (US
   * survey foot etc.). Defaults to `1` (source already in metres).
   */
  readonly linearUnitToMetres?: number;
}

// ── metric primitives ──────────────────────────────────────────────

/** Identifiers for the deterministic metrics shipped in v0.3.9. */
export type TerrainMetricName =
  | 'slope-degrees'
  | 'roughness-rms'
  | 'curvature-mean'
  | 'elevation-variance'
  | 'point-density'
  | 'height-above-local-surface'
  | 'neighborhood-elevation-range'
  | 'local-planarity';

/** A single metric value with its provenance. */
export interface TerrainMetric {
  /** Which metric this is. */
  readonly name: TerrainMetricName;
  /** The numeric value. Unit is implied by `name`. */
  readonly value: number;
  /** Number of samples in the neighborhood that produced this value. */
  readonly sampleCount: number;
  /** Neighborhood radius used. */
  readonly radius: number;
}

// ── coverage + quality ─────────────────────────────────────────────

/** How thoroughly the analysis walked the source cloud. */
export type TerrainCoverageMode =
  | 'full' // every source point participated
  | 'resident-only' // streaming scan; only resident nodes were walked
  | 'sampled'; // budget triggered a stride / random sample

/** The honesty fields every result MUST carry. */
export interface TerrainCoverageMeta {
  readonly coverage: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  /**
   * 0..100 summary suitable for a badge. Optional — only set when a
   * real engine pass produced a measurement. v0.3.10 honesty pass:
   * the cheap-summary path used to push a hardcoded `60` (static) /
   * `50` (streaming) here, which rendered as a green/yellow band on
   * the Dataset Intelligence card and implied the engine had measured
   * stability. It hadn't — the number was a constant. Leaving the
   * field unset when no engine signal exists lets the summariser
   * render "—" instead of a fake "60%", matching the other engine-
   * only rows (Complexity, Ground Visibility).
   */
  readonly confidence?: number;
  /** Free-text caveats — surface order is preserved by the UI. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Compact quality summary the UI shows next to a result chip
 * without expanding the full coverage meta.
 */
export interface TerrainQualitySummary {
  /** 0..100. */
  readonly confidence: number;
  readonly coverage: TerrainCoverageMode;
  /** True when the result depends on resident streaming nodes only. */
  readonly residentOnly: boolean;
}

// ── job + result envelope ──────────────────────────────────────────

/** A request the engine routes to a worker. */
export interface TerrainAnalysisRequest {
  /** What kind of analysis to run. v0.3.9 ships the metric set only. */
  readonly kind: 'metrics';
  /** Per-tile metric requests — empty array means "every tile". */
  readonly tiles: ReadonlyArray<number>;
  /** Metrics to compute. */
  readonly metrics: ReadonlyArray<TerrainMetricName>;
  /** Optional neighborhood radius override. */
  readonly radius?: number;
  /** Maximum points to walk before forcing a sampled coverage. */
  readonly pointBudget?: number;
}

/**
 * The unified result envelope. Every future producer (DTM, DSM,
 * contours, hillshade, slope map, HAG) returns this shape with the
 * `payload` discriminator pointing at the concrete result.
 *
 * `payload` is a PARTIAL record — the analyser only populates the
 * metrics the request asked for. Consumers MUST check for `undefined`
 * before reading a metric array.
 */
export interface TerrainAnalysisResult extends TerrainCoverageMeta {
  /** Echoes the request kind. */
  readonly kind: 'metrics';
  /** Per-point or per-tile metric arrays, keyed by metric name. */
  readonly payload: Readonly<Partial<Record<TerrainMetricName, ReadonlyArray<number>>>>;
  /** Total wall-clock time in ms for the analysis. */
  readonly elapsedMs: number;
}

/** Status of an in-flight terrain job. */
export type TerrainJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed';

// ── ground-confidence scaffold (no classification yet) ─────────────

/**
 * A per-point ground-likelihood score with the per-axis breakdown
 * that produced it. v0.3.9 SHIPS THE SCORING SCAFFOLD ONLY — no
 * threshold, no class assignment. A future release will fold this
 * into SMRF / PMF / Progressive TIN / slope filtering /
 * height-above-neighbour filtering classifiers.
 */
export interface GroundScore {
  /** 0..100 — high means "more likely ground". */
  readonly confidence: number;
  readonly slopeScore: number;
  readonly roughnessScore: number;
  readonly varianceScore: number;
  readonly densityScore: number;
  /** Ordered list of human-readable explanations. */
  readonly reasons: ReadonlyArray<string>;
}
