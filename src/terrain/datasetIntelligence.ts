/**
 * datasetIntelligence.ts
 *
 * Pure-data classifiers that turn the Terrain Foundation's
 * deterministic outputs into compact, user-readable buckets — the
 * Inspector's "Dataset Intelligence" card renders these as text and
 * coloured chips.
 *
 * This layer DOES NOT classify points, does NOT extract ground, does
 * NOT generate a DTM/DSM/contours, and does NOT make survey-grade
 * claims. It is informational only.
 *
 * Inputs come from layers that already exist:
 *
 *   - point count + bounding-box volume + optional resident-neighbour
 *     density (TerrainPartition)
 *   - aggregate slope / roughness / elevation variance over a
 *     bounded sample (TerrainMetrics, called via TerrainEngine)
 *   - terrain suggestion (classification histogram, optional)
 *   - coverage meta from TerrainAnalysisResult (TerrainResult)
 *
 * The output bands are chosen to be wide enough that small numeric
 * jitter at bucket boundaries doesn't make the card flicker. Every
 * band is documented with the analytic threshold it represents so
 * a reader can reason about why a dataset ended up in a given bucket.
 *
 * No DOM, no three.js, no I/O — usable from the engine, the worker,
 * or a future test harness without dragging the renderer along.
 */

import type {
  TerrainCoverageMeta,
  TerrainCoverageMode,
} from './TerrainContracts';
import type { TerrainSuggestionResult } from '../render/terrainSuggestion';

// ── Output buckets ─────────────────────────────────────────────────

/** Point-density bucket. */
export type DensityBucket = 'sparse' | 'moderate' | 'dense' | 'very-dense';

/**
 * Terrain-complexity bucket. `'unknown'` is the explicit "we have no
 * usable slope / roughness / variance signal" reading; the UI renders
 * it as "—" so a missing engine pass never displays a confident
 * "Low" reading that would suggest the dataset was actually analysed.
 */
export type ComplexityBucket = 'unknown' | 'low' | 'moderate' | 'high' | 'very-high';

/**
 * Ground-visibility-estimate bucket. `'unknown'` is the explicit
 * "no classification histogram or roughness signal" reading. Same
 * honest-display rationale as `ComplexityBucket`.
 */
export type GroundVisibilityBucket = 'unknown' | 'poor' | 'fair' | 'good' | 'excellent';

/** Streaming coverage bucket — mirrors TerrainCoverageMode. */
export type CoverageBucket = TerrainCoverageMode;

/**
 * Confidence colour band — drives the chip colour, not the value.
 *
 * v0.3.10 honesty pass — added `'unknown'`. Used when no engine pass
 * has produced a confidence measurement (the cheap header-only
 * summary that runs at load time has no terrain-stability signal).
 * Renders as a muted-gray chip with a "—" label so the card reads as
 * "we don't know yet" instead of fabricating a green/yellow/red band
 * from a hardcoded constant the way `60` and `50` used to.
 */
export type ConfidenceBand = 'green' | 'yellow' | 'red' | 'unknown';

// ── Input + result types ───────────────────────────────────────────

/**
 * Everything the orchestrator can hand the summariser. Every field is
 * optional so the card can render partial information without the
 * orchestrator having to lie about what it knows.
 */
export interface DatasetIntelligenceInput {
  /** Number of points the loader declared on the cloud. */
  readonly pointCount?: number;
  /**
   * Bounding-box volume in scan-local cubic units. Used together
   * with `pointCount` to estimate density. Pass the bbox volume in
   * metres-cubed when the source CRS uses metres; the summariser does
   * not apply a unit scale.
   */
  readonly bboxVolume?: number;
  /**
   * Average resident-neighbour density (points per metre cubed)
   * measured by a sampled TerrainEngine pass. Optional — when present
   * it overrides the bbox-derived estimate.
   */
  readonly residentDensity?: number;
  /**
   * Aggregate slope in degrees, averaged across the sampled
   * neighborhoods. Drives the complexity bucket together with
   * `meanRoughness` and `elevationVariance`.
   */
  readonly meanSlopeDeg?: number;
  /** Aggregate RMS roughness in metres. */
  readonly meanRoughness?: number;
  /** Aggregate elevation variance in metres-squared. */
  readonly elevationVariance?: number;
  /** Optional terrain-suggestion (classification histogram). */
  readonly terrainSuggestion?: TerrainSuggestionResult;
  /** Coverage envelope from the Terrain Engine. */
  readonly coverageMeta?: TerrainCoverageMeta;
  /**
   * Metric version label — surfaced in the Details panel so power
   * users can tell which v0.3.x cut produced the summary.
   */
  readonly metricVersion?: string;
}

/** The summarised, presentation-ready view. */
export interface DatasetIntelligence {
  readonly density: { readonly bucket: DensityBucket; readonly label: string };
  readonly complexity: {
    readonly bucket: ComplexityBucket;
    readonly label: string;
  };
  readonly groundVisibility: {
    readonly bucket: GroundVisibilityBucket;
    readonly label: string;
  };
  readonly coverage: {
    readonly bucket: CoverageBucket;
    readonly label: string;
    readonly streamingWarning?: string;
  };
  readonly confidence: {
    readonly value: number;
    readonly band: ConfidenceBand;
    readonly label: string;
  };
  readonly details: {
    readonly coverageMode: string;
    readonly sourcePointCount: number | null;
    readonly analyzedPointCount: number | null;
    readonly metricVersion: string;
    readonly engineStatus: 'active' | 'idle';
  };
}

// ── Classifiers — every band reasoned about explicitly ─────────────

/**
 * Density bucket. Two paths:
 *  - If `residentDensity` is supplied (the engine ran a sampled pass),
 *    use empirical points-per-cubic-metre thresholds calibrated against
 *    typical airborne (low), drone (mid), terrestrial (high) scans.
 *  - Else fall back to `pointCount / bboxVolume` with the same scale.
 *
 * Returns 'sparse' when neither input is available — the card then
 * reads as "Sparse" rather than crashing, which is honest.
 */
export function classifyDensity(
  input: Pick<DatasetIntelligenceInput, 'pointCount' | 'bboxVolume' | 'residentDensity'>,
): DensityBucket {
  // Prefer the engine-measured value when present.
  const candidate =
    input.residentDensity !== undefined && Number.isFinite(input.residentDensity)
      ? input.residentDensity
      : input.pointCount !== undefined &&
          input.bboxVolume !== undefined &&
          Number.isFinite(input.pointCount) &&
          Number.isFinite(input.bboxVolume) &&
          input.bboxVolume > 0
        ? input.pointCount / input.bboxVolume
        : NaN;
  if (!Number.isFinite(candidate) || candidate <= 0) return 'sparse';
  // Thresholds in points per cubic metre. The bands are deliberately
  // wide so a typical drone scan reads as Dense, a typical airborne
  // scan reads as Moderate, and an interior terrestrial scan reads as
  // Very Dense — without claiming survey-grade accuracy.
  if (candidate < 4) return 'sparse';
  if (candidate < 40) return 'moderate';
  if (candidate < 400) return 'dense';
  return 'very-dense';
}

/** Human label for a density bucket. */
export function densityLabel(b: DensityBucket): string {
  switch (b) {
    case 'sparse':
      return 'Sparse';
    case 'moderate':
      return 'Moderate';
    case 'dense':
      return 'Dense';
    case 'very-dense':
      return 'Very Dense';
  }
}

/**
 * Terrain complexity. Higher slope, roughness, and elevation variance
 * all push toward "Very High". The three signals are normalised then
 * combined with equal weight. A missing signal contributes 0 — the
 * resulting bucket is then a lower-bound estimate.
 */
export function classifyComplexity(
  input: Pick<DatasetIntelligenceInput, 'meanSlopeDeg' | 'meanRoughness' | 'elevationVariance'>,
): ComplexityBucket {
  // No engine signal yet → return 'unknown' so the UI renders an
  // honest "—" instead of fabricating a confident "Low" reading.
  const haveSlope = input.meanSlopeDeg !== undefined && Number.isFinite(input.meanSlopeDeg);
  const haveRough = input.meanRoughness !== undefined && Number.isFinite(input.meanRoughness);
  const haveVar = input.elevationVariance !== undefined && Number.isFinite(input.elevationVariance);
  if (!haveSlope && !haveRough && !haveVar) return 'unknown';
  const slopeNorm = normalise01(input.meanSlopeDeg, 0, 45);
  const roughNorm = normalise01(input.meanRoughness, 0, 0.5);
  const varNorm = normalise01(input.elevationVariance, 0, 25);
  const score = (slopeNorm + roughNorm + varNorm) / 3;
  // Score bands — picked so flat ground (< 5°, < 5 cm RMS) reads Low,
  // rolling hills (~15°, ~15 cm RMS) reads Moderate, foothills
  // (~25°, ~30 cm RMS) reads High, and mountainous terrain
  // (> 35°, > 40 cm RMS) reads Very High.
  if (score < 0.15) return 'low';
  if (score < 0.4) return 'moderate';
  if (score < 0.7) return 'high';
  return 'very-high';
}

/** Human label for a complexity bucket. */
export function complexityLabel(b: ComplexityBucket): string {
  switch (b) {
    case 'unknown':
      return '—';
    case 'low':
      return 'Low';
    case 'moderate':
      return 'Moderate';
    case 'high':
      return 'High';
    case 'very-high':
      return 'Very High';
  }
}

/**
 * Ground-visibility estimate. This is NOT a ground-classification
 * confidence — it is a heuristic for "if a future terrain extractor
 * tried to derive ground here, how successful is it likely to be?".
 * Inputs:
 *
 *   - terrainSuggestion.groundFraction: the share of points already
 *     classified as ground in the source file.
 *   - terrainSuggestion.vegetationFraction: penalises dense canopy.
 *   - meanRoughness: high local roughness pushes the bucket down.
 *
 * Returns 'poor' when nothing useful is available — the UI then
 * reads as "Poor" rather than claiming "Excellent" out of thin air.
 */
export function classifyGroundVisibility(
  input: Pick<
    DatasetIntelligenceInput,
    'terrainSuggestion' | 'meanRoughness' | 'residentDensity'
  >,
): GroundVisibilityBucket {
  const suggest = input.terrainSuggestion;
  const haveClass = suggest !== undefined && Number.isFinite(suggest.groundFraction);
  const haveRough = input.meanRoughness !== undefined && Number.isFinite(input.meanRoughness);
  const haveDensity =
    input.residentDensity !== undefined && Number.isFinite(input.residentDensity);
  // No usable signal → return 'unknown'. The UI renders this as "—"
  // so the user never sees a confident "Poor" reading when nothing
  // was actually measured.
  if (!haveClass && !haveRough && !haveDensity) return 'unknown';
  // Prefer the source-classification signal when it's available —
  // it's the most direct evidence we have.
  let score = 0;
  if (suggest && Number.isFinite(suggest.groundFraction)) {
    score += clamp01(suggest.groundFraction);
    score -= 0.5 * clamp01(suggest.vegetationFraction ?? 0);
  } else if (haveDensity) {
    // Without classification, dense neighbourhoods get a small bump.
    score += clamp01((input.residentDensity ?? 0) / 200);
  }
  // Roughness penalty — fold local terrain disorder into the score.
  if (haveRough) {
    score -= clamp01((input.meanRoughness ?? 0) / 0.5) * 0.4;
  }
  if (score < 0.15) return 'poor';
  if (score < 0.35) return 'fair';
  if (score < 0.65) return 'good';
  return 'excellent';
}

/** Human label for a ground-visibility bucket. */
export function groundVisibilityLabel(b: GroundVisibilityBucket): string {
  switch (b) {
    case 'unknown':
      return '—';
    case 'poor':
      return 'Poor';
    case 'fair':
      return 'Fair';
    case 'good':
      return 'Good';
    case 'excellent':
      return 'Excellent';
  }
}

/** Coverage bucket maps the engine's coverage mode 1:1. */
export function classifyCoverage(meta: TerrainCoverageMeta | undefined): CoverageBucket {
  // Without engine output the safest reading is "sampled" — that
  // triggers the streaming-warning string downstream so the user
  // never sees an over-confident result.
  if (!meta) return 'sampled';
  return meta.coverage;
}

/** Human label for a coverage bucket. */
export function coverageLabel(b: CoverageBucket): string {
  switch (b) {
    case 'full':
      return 'Full Dataset';
    case 'resident-only':
      return 'Resident Nodes';
    case 'sampled':
      return 'Sampled Analysis';
  }
}

/**
 * Streaming-warning string for the coverage row. Returns `undefined`
 * for `full` coverage — there's nothing to caveat — and a short
 * caveat for the partial modes. The exact wording is the one called
 * out in the brief and is repeated verbatim across releases so the
 * tone stays consistent.
 */
export function coverageStreamingWarning(b: CoverageBucket): string | undefined {
  if (b === 'full') return undefined;
  return 'Analysis is based on currently loaded data. Results may change as additional points stream.';
}

/**
 * Confidence colour band. The numeric value comes directly from the
 * engine's coverage-meta confidence; the band is purely a visual hint:
 *
 *   - undefined → unknown (no engine pass yet — render muted/"—")
 *   - 0..49     → red    ("low — interpret with caution")
 *   - 50..74    → yellow ("moderate")
 *   - 75..100   → green  ("high")
 *
 * v0.3.10 honesty pass — `'unknown'` is the new state for the cheap
 * header-only summary that runs at load time. Previously the loader
 * pushed a hardcoded `60`/`50` so the chip always rendered a green/
 * yellow band, implying the engine had measured stability when it
 * hadn't. Returning `'unknown'` when the input is absent or non-finite
 * lets the card surface "—" instead of a fake bucket.
 */
export function confidenceBand(confidence: number | undefined): ConfidenceBand {
  if (confidence === undefined || !Number.isFinite(confidence)) return 'unknown';
  if (confidence < 50) return 'red';
  if (confidence < 75) return 'yellow';
  return 'green';
}

// ── Top-level summariser ──────────────────────────────────────────

/**
 * Reduce a raw input bundle into a presentation-ready summary.
 * Returns `null` when the input is so empty there's nothing safe
 * to say — the card then renders its empty state.
 */
export function summariseDataset(input: DatasetIntelligenceInput): DatasetIntelligence | null {
  // Nothing useful at all? — let the UI fall back to the empty state.
  const hasAnyData =
    input.pointCount !== undefined ||
    input.residentDensity !== undefined ||
    input.meanSlopeDeg !== undefined ||
    input.meanRoughness !== undefined ||
    input.elevationVariance !== undefined ||
    input.terrainSuggestion !== undefined ||
    input.coverageMeta !== undefined;
  if (!hasAnyData) return null;
  const densityBucket = classifyDensity(input);
  const complexityBucket = classifyComplexity(input);
  const groundBucket = classifyGroundVisibility(input);
  const coverageBucket = classifyCoverage(input.coverageMeta);
  // v0.3.10 honesty pass — when no engine pass has produced a confidence
  // value, render "—" instead of fabricating a "0%" / "60%" badge. The
  // band returns 'unknown' for the same input so the chip styling
  // matches the textual state.
  const confidenceRaw = input.coverageMeta?.confidence;
  const confidenceHasSignal =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw);
  const confidenceValue = confidenceHasSignal ? confidenceRaw : Number.NaN;
  const band = confidenceBand(confidenceRaw);
  const confidenceLabel = confidenceHasSignal
    ? `${Math.round(clamp(confidenceRaw, 0, 100))}%`
    : '—';
  return {
    density: { bucket: densityBucket, label: densityLabel(densityBucket) },
    complexity: { bucket: complexityBucket, label: complexityLabel(complexityBucket) },
    groundVisibility: {
      bucket: groundBucket,
      label: groundVisibilityLabel(groundBucket),
    },
    coverage: {
      bucket: coverageBucket,
      label: coverageLabel(coverageBucket),
      streamingWarning: coverageStreamingWarning(coverageBucket),
    },
    confidence: { value: confidenceValue, band, label: confidenceLabel },
    details: {
      coverageMode: coverageLabel(coverageBucket),
      sourcePointCount:
        typeof input.coverageMeta?.sourcePointCount === 'number'
          ? input.coverageMeta.sourcePointCount
          : (input.pointCount ?? null),
      analyzedPointCount:
        typeof input.coverageMeta?.analyzedPointCount === 'number'
          ? input.coverageMeta.analyzedPointCount
          : null,
      metricVersion: input.metricVersion ?? 'v0.3.9',
      engineStatus: input.coverageMeta ? 'active' : 'idle',
    },
  };
}

// ── tiny local helpers ────────────────────────────────────────────

/** Clamp into [0, 1]. */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Clamp into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Normalise a value to [0, 1] across [lo, hi]; 0 when missing. */
function normalise01(value: number | undefined, lo: number, hi: number): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  if (hi <= lo) return 0;
  return clamp01((value - lo) / (hi - lo));
}
