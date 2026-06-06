/**
 * analyseContours.ts
 *
 * Integration facade — composes the whole pure-data pipeline
 * into one call so the UI layer (or a worker) has a single, testable
 * entry point and never re-implements the sequencing. This is the seam
 * the AnalysePanel and the contour worker call; everything it returns is
 * already honest (confidence measured, validated, interval gated).
 *
 * Flow: classify ground → rasterise DTM → per-cell confidence →
 * hold-out validation + calibration → gate intervals against the
 * measured RMSE → contour at the chosen interval → stitch → style →
 * build export model → tally evidence.
 *
 * The pipeline is split into two pure halves so the heavy work is never
 * redone when only the contour interval changes:
 *
 *   - {@link computeTerrainCore} runs everything that depends ONLY on the
 *     points + ground/grid/CRS parameters (classification, ground filter,
 *     DTM raster + hardening, void fill, hold-out validation, confidence
 *     calibration, the interval gate itself, quality + scoring, surface
 *     models). Its result is cacheable across interval changes.
 *   - {@link contoursFromCore} runs only the interval-dependent stages
 *     (the interval CHOICE, contours → stitch → style → smooth → labels →
 *     feature model → tally, and the requested-interval-aware grid
 *     recommendation).
 *
 * {@link analyseContours} is the composition of the two, so its public
 * result is byte-identical to the single-pass implementation.
 *
 * Input: a Float32Array of XYZ triples (length 3N) is the preferred,
 * zero-copy-friendly entry; `TerrainPoint[]` is still accepted for
 * existing callers. The typed-array form is boxed into points ONCE inside
 * the core, so an interval re-run never re-boxes.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainPoint } from '../TerrainContracts';
import {
  classifyGroundSmrf,
  type GroundFilterParams,
  type VerticalAxis,
} from '../ground/groundFilter';
import { rasterizeDtm } from '../ground/rasterizeDtm';
import { buildDtmGrid, type DtmGrid } from '../ground/cellConfidence';
import { removeSpikes } from '../ground/despike';
import { computeCellMetrics, type CellMetricsSummary } from '../quality/cellMetrics';
import { terrainQualityScore, type TerrainQualityScore } from '../quality/terrainQualityScore';
import { demAccuracyStandards, type DemAccuracyStandards } from '../quality/demAccuracyStandards';
import {
  buildDsm,
  emptySurfaceGrid,
  surfaceStats,
  heightAboveGround,
  type SurfaceStats,
  type CanopyHeight,
} from '../surface/buildDsm';
import {
  shadeFromSlopeAspect,
  slopeStats,
  type SlopeStats,
  type HillshadeResult,
} from '../surface/hillshade';
import { hornSlopeAspect } from '../ground/terrainDerivatives';
import { horizontalCellMetres } from '../ground/horizontalScale';
import { excludeNonGroundClasses } from '../ground/classificationFilter';
import { holdoutValidateDtm } from '../validate/holdoutRmse';
import { checkCalibration } from '../validate/calibrationCheck';
import {
  fitConfidenceCalibration,
  applyConfidenceCalibration,
} from '../validate/calibrateConfidence';
import {
  classifyCellStatus,
  tallyCellStatus,
  type CellStatusTally,
} from '../quality/dtmCellStatus';
import { evaluateDtmQuality, type DtmQualityReport } from '../quality/dtmQualityGate';
import { recommendGrid, type GridRecommendation } from '../quality/recommendGrid';
import type { CalibrationResult, ValidationReport } from '../validate/ValidationReport';
import { gateIntervals, type IntervalGateResult } from './intervalGate';
import { contoursAt, type ContourSet } from './contoursAt';
import { stitchContourSet, type StitchedLevel } from './stitchContours';
import { styleLevels, type ContourStyleResult } from './contourStyle';
import { buildFeatureModel, type ContourFeatureModel } from './contourFeatureModel';
import { tallyContourSet, type GradeTally } from './evidenceGrade';
import { chaikinSmooth } from './smoothing';
import { placeLabels, type ContourLabel } from './labelPlacement';
import { computeVerticalAccuracy, type VerticalAccuracy } from '../validate/verticalAccuracy';

/**
 * Core (interval-independent) options for {@link computeTerrainCore}. These
 * are exactly the parameters the heavy pipeline depends on — none of them
 * change when only the contour interval is re-picked.
 */
export interface TerrainCoreParams {
  /** DTM / contour grid cell size, source linear units. Must be > 0. */
  readonly cellSizeM: number;
  /** Ground-filter overrides (sensible defaults otherwise). */
  readonly ground?: Partial<Omit<GroundFilterParams, 'cellSizeM' | 'verticalAxis'>>;
  /** Horizontal CRS (required for usable exports; warns when null). */
  readonly crs?: string | null;
  /**
   * True when the horizontal frame is geographic (degrees), so slope and
   * hillshade can convert the cell size to metres. Default false (projected).
   */
  readonly isGeographic?: boolean;
  /**
   * Metres per source vertical unit (1 for metre data, ~0.3048 for feet). The
   * hold-out RMSE is reported in metres using this, so the quality score and
   * the "Vertical RMSE … m" readout are correct for feet-based CRSs. Default 1.
   */
  readonly verticalUnitToMetres?: number;
  /** Vertical datum. */
  readonly verticalDatum?: string | null;
  /** Vertical axis of the source frame. Default 'z'. */
  readonly verticalAxis?: VerticalAxis;
  /**
   * Per-point ASPRS classification, index-aligned with the points. When
   * present, vegetation / building / noise returns are dropped before ground
   * filtering so the bare-earth surface never anchors to canopy or rooftops.
   * The DSM (top surface, for above-ground height) still uses the full cloud.
   */
  readonly classification?: ReadonlyArray<number> | Uint8Array;
  /** ASPRS classes to exclude before ground filtering. Default veg/building/noise. */
  readonly excludeClasses?: ReadonlyArray<number>;
  /** Hold-out PRNG seed for reproducible validation. Default 1. */
  readonly holdoutSeed?: number;
}

/**
 * Interval-dependent options for {@link contoursFromCore}. Re-picking any of
 * these is cheap because the core is reused unchanged.
 */
export interface IntervalContourParams {
  /** Explicit contour interval; when omitted, the gate's recommendation is used. */
  readonly intervalM?: number;
  /** Every Nth contour is an index contour. Default 5. */
  readonly indexEvery?: number;
  /** Smooth high-confidence contour runs (honesty-preserving). Default true. */
  readonly smooth?: boolean;
  /** Label spacing along index contours, source units. Default 25×cellSize. */
  readonly labelSpacingM?: number;
}

/** Options for {@link analyseContours} — the union of the two halves. */
export interface AnalyseContoursParams extends TerrainCoreParams, IntervalContourParams {}

/**
 * Provenance of the actual generation run, populated from the real config the
 * pipeline used (not mirrored constants). The DEM README derives its
 * "Generation parameters" section from this so it can never drift from what
 * actually produced the surface.
 */
export interface AnalyseGenerationParams {
  /** Void-fill interpolation method the DTM builder ran with. */
  readonly interpolation: 'idw' | 'geodesic';
  /** True when contour smoothing was applied (params.smooth !== false). */
  readonly smoothing: boolean;
  /** True when the blunder-only despike pass ran before building the surface. */
  readonly despike: boolean;
}

/**
 * The interval-independent product of the pipeline. Everything here depends
 * only on the points + {@link TerrainCoreParams}; nothing reads the contour
 * interval. Cache one of these and re-run {@link contoursFromCore} for as many
 * intervals as the UI asks for.
 */
export interface TerrainCore {
  readonly dtm: DtmGrid;
  readonly validation: ValidationReport;
  readonly calibration: CalibrationResult;
  /** True when the reported confidence was recalibrated against measured error. */
  readonly confidenceCalibrationApplied: boolean;
  /** Vertical tolerance τ the calibrated confidence is defined against, or null. */
  readonly confidenceToleranceM: number | null;
  /** DTM quality gate verdict (ready / previewOnly / blocked) + metrics + reasons. */
  readonly quality: DtmQualityReport;
  /** Composite 0–100 terrain quality score + weighted component breakdown. */
  readonly qualityScore: TerrainQualityScore;
  /** Per-cell metric rollup: density, completeness, edge risk. */
  readonly cellMetrics: CellMetricsSummary;
  /** Classified vegetation/building/noise returns dropped before ground filtering. */
  readonly excludedByClassification: number;
  /** ASPRS/USGS 3DEP accuracy expression: NVA, VVA, and Quality Level. */
  readonly accuracyStandards: DemAccuracyStandards;
  /** Surface models: top-surface DSM, height-above-ground, slope, hillshade. */
  readonly surface: {
    readonly dsm: SurfaceStats;
    readonly canopy: CanopyHeight;
    readonly slope: SlopeStats;
    readonly hillshade: HillshadeResult;
    /** Cached Horn gradient grids (slope tangent + aspect in radians) on the
     *  DTM grid, for interactive re-lighting and point sampling. */
    readonly relief: { readonly slope: Float32Array; readonly aspect: Float32Array };
  };
  /** Per-status cell counts (measured / interpolated / empty / lowConfidence / edgeRisk). */
  readonly cellStatusTally: CellStatusTally;
  /** Interval gate (options + recommendation). Interval-independent: it is a
   *  function of cell size, relief and the measured RMSE only. */
  readonly gate: IntervalGateResult;
  /** ASPRS vertical accuracy derived from the validation pass. */
  readonly accuracy: VerticalAccuracy;
  readonly elevationRangeM: number;
  /** Min covered elevation, or NaN when there is no coverage. */
  readonly minZ: number;
  /** Max covered elevation, or NaN when there is no coverage. */
  readonly maxZ: number;
  /** Void-fill method the DTM builder ran with (provenance). */
  readonly interpolation: 'idw' | 'geodesic';
  /** True when the blunder-only despike pass ran (always true today). */
  readonly despikeApplied: boolean;
  /** Resolved horizontal CRS (echoed for the contour stage + result). */
  readonly crs: string | null;
  /** Resolved vertical datum (echoed for the contour stage + result). */
  readonly verticalDatum: string | null;
  /** Resolved grid cell size (source units). */
  readonly cellSizeM: number;
  /** Grid-recommendation geometry inputs (the contour stage adds the
   *  interval-dependent requested-interval term). */
  readonly gridGeometry: {
    readonly pointCount: number;
    readonly widthM: number;
    readonly depthM: number;
    readonly reliefM: number;
  };
  /** Ordered core warnings (classification, ground, despike, void-fill). The
   *  contour stage appends its interval-dependent warnings after these. */
  readonly coreWarnings: ReadonlyArray<string>;
}

/** Everything the UI needs from one analysis pass. */
export interface AnalyseContoursResult {
  readonly dtm: DtmGrid;
  readonly validation: ValidationReport;
  readonly calibration: CalibrationResult;
  /** True when the reported confidence was recalibrated against measured error. */
  readonly confidenceCalibrationApplied: boolean;
  /** Vertical tolerance τ the calibrated confidence is defined against, or null. */
  readonly confidenceToleranceM: number | null;
  /** DTM quality gate verdict (ready / previewOnly / blocked) + metrics + reasons. */
  readonly quality: DtmQualityReport;
  /** Composite 0–100 terrain quality score + weighted component breakdown. */
  readonly qualityScore: TerrainQualityScore;
  /** Per-cell metric rollup: density, completeness, edge risk. */
  readonly cellMetrics: CellMetricsSummary;
  /** Classified vegetation/building/noise returns dropped before ground filtering. */
  readonly excludedByClassification: number;
  /** ASPRS/USGS 3DEP accuracy expression: NVA, VVA, and Quality Level. */
  readonly accuracyStandards: DemAccuracyStandards;
  /** Surface models: top-surface DSM, height-above-ground, slope, hillshade. */
  readonly surface: {
    readonly dsm: SurfaceStats;
    readonly canopy: CanopyHeight;
    readonly slope: SlopeStats;
    readonly hillshade: HillshadeResult;
    /** Cached Horn gradient grids (slope tangent + aspect in radians) on the
     *  DTM grid, for interactive re-lighting and point sampling. */
    readonly relief: { readonly slope: Float32Array; readonly aspect: Float32Array };
  };
  /** Per-status cell counts (measured / interpolated / empty / lowConfidence / edgeRisk). */
  readonly cellStatusTally: CellStatusTally;
  /** Recommended DTM grid + contour interval for this dataset. */
  readonly gridRecommendation: GridRecommendation;
  readonly gate: IntervalGateResult;
  /** The interval actually used for the contours. */
  readonly intervalM: number | null;
  readonly contours: ContourSet;
  readonly stitched: StitchedLevel[];
  readonly style: ContourStyleResult;
  readonly model: ContourFeatureModel;
  readonly tally: GradeTally;
  /** Elevation labels placed along index contours (for overlay / SVG). */
  readonly labels: ContourLabel[];
  /** ASPRS vertical accuracy derived from the validation pass. */
  readonly accuracy: VerticalAccuracy;
  readonly elevationRangeM: number;
  /** Actual generation parameters used (single source of truth for the README). */
  readonly generationParams: AnalyseGenerationParams;
  readonly warnings: string[];
}

const EMPTY_GATE: IntervalGateResult = { options: [], recommendedM: null, warnings: [] };

/**
 * Box a Float32Array of XYZ triples (length 3N) into `TerrainPoint[]`. The
 * adapter that lets the existing pure stages — which all speak
 * `TerrainPoint[]` — consume the zero-copy-friendly typed-array entry. Boxed
 * ONCE per core run, never per interval.
 */
function positionsToPoints(positions: Float32Array): TerrainPoint[] {
  const n = (positions.length / 3) | 0;
  const points: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
  }
  return points;
}

/**
 * Accepted point input: the preferred zero-copy-friendly Float32Array of XYZ
 * triples (length 3N), or a `TerrainPoint[]` for existing callers.
 */
export type TerrainPointInput = Float32Array | ReadonlyArray<TerrainPoint>;

/** Normalise either accepted input form to the `TerrainPoint[]` the stages need. */
function normalisePoints(input: TerrainPointInput): ReadonlyArray<TerrainPoint> {
  return input instanceof Float32Array ? positionsToPoints(input) : input;
}

/**
 * Run every interval-INDEPENDENT stage of the pipeline. The expensive half:
 * classification → ground filter → DTM raster + hardening → void fill →
 * hold-out validation + confidence calibration → interval gate → quality +
 * scoring → surface models. The result is cacheable; feed it to
 * {@link contoursFromCore} for as many intervals as needed without redoing any
 * of this work.
 *
 * Accepts a Float32Array of XYZ triples (boxed once internally) or a
 * `TerrainPoint[]`. Deterministic.
 */
export function computeTerrainCore(
  input: TerrainPointInput,
  params: TerrainCoreParams,
): TerrainCore {
  const points = normalisePoints(input);
  const warnings: string[] = [];
  const verticalAxis: VerticalAxis = params.verticalAxis ?? 'z';
  const crs = params.crs ?? null;
  const verticalDatum = params.verticalDatum ?? null;

  // 0) Honour existing classification — drop vegetation / buildings / noise
  // before ground filtering so the bare-earth surface can't anchor to canopy
  // or rooftops. The full cloud is still used for the DSM further down, so
  // above-ground height keeps measuring those very returns.
  const classFilter = excludeNonGroundClasses(points, params.classification, params.excludeClasses);
  const groundPts = classFilter.points;
  if (classFilter.excludedCount > 0) {
    warnings.push(
      `Excluded ${classFilter.excludedCount} classified vegetation/building/noise return(s) before ground filtering.`,
    );
  }

  // 1) Ground classification.
  const gf = classifyGroundSmrf(groundPts, {
    cellSizeM: params.cellSizeM,
    maxWindowCells: params.ground?.maxWindowCells ?? 8,
    slope: params.ground?.slope ?? 0.2,
    elevationThresholdM: params.ground?.elevationThresholdM ?? 0.5,
    scalingFactorM: params.ground?.scalingFactorM,
    // Despike by default in the pipeline (the leaf stays strict-min).
    floorPercentile: params.ground?.floorPercentile ?? 5,
    verticalAxis,
  });
  warnings.push(...gf.warnings);

  // 2) DTM raster aligned to the filter grid + 3) per-cell confidence.
  const raster = rasterizeDtm(groundPts, gf.isGround, {
    grid: {
      originH1: gf.originH1,
      originH2: gf.originH2,
      cols: gf.cols,
      rows: gf.rows,
      cellSizeM: params.cellSizeM,
    },
    verticalAxis,
  });
  // 2b) DTM hardening — drop blunder cells (a lone ground return far from its
  //     neighbours) so they don't warp the surface; the builder re-fills them
  //     by interpolation. Real outliers only — smooth terrain loses nothing.
  let workingRaster = raster;
  const hadData0 = new Uint8Array(raster.counts.length);
  let measuredCellCount = 0;
  for (let i = 0; i < hadData0.length; i++) {
    if (raster.counts[i] > 0) { hadData0[i] = 1; measuredCellCount++; }
  }
  // Conservative, blunder-only thresholds (6σ, ≥30 cm absolute) so legitimate
  // small features in flat terrain are kept; only gross outliers are removed.
  // The blunder-only despike pass is part of every generation run; the README
  // derives its provenance from this fact, not a mirrored constant.
  const despikeApplied = true;
  const despiked = removeSpikes(raster.z, hadData0, raster.cols, raster.rows, {
    madThreshold: 6,
    minDeviationM: 0.3,
  });
  // Safety cap: if "outliers" exceed 2% of measured cells the data is noisy,
  // not spiky — removing that much would distort the surface, so leave it.
  const removalCap = Math.max(4, Math.ceil(measuredCellCount * 0.02));
  if (despiked.removed > 0 && despiked.removed <= removalCap) {
    const counts2 = raster.counts.slice();
    let filled = 0;
    for (let i = 0; i < counts2.length; i++) {
      if (despiked.hadData[i] === 0) counts2[i] = 0;
      if (counts2[i] > 0) filled++;
    }
    workingRaster = { ...raster, z: despiked.z, counts: counts2, filledCellCount: filled };
    warnings.push(`Removed ${despiked.removed} outlier ground cell(s) before building the surface.`);
  } else if (despiked.removed > removalCap) {
    warnings.push(
      `Outlier detection flagged ${despiked.removed} cells (> 2% of data) — left unchanged; the surface looks noisy rather than spiky.`,
    );
  }
  // Single source of truth for the void-fill method: the README's provenance
  // reads this back off the result, so it can't drift from what actually ran.
  const interpolation: 'idw' | 'geodesic' = 'geodesic';
  let dtm = buildDtmGrid(workingRaster, {
    crs,
    verticalDatum,
    isGeographic: params.isGeographic,
    interpolation,
    // Demote one-sided (extrapolated) fills toward dashed/gap so surface that
    // is only supported from a single direction can't read as confident.
    extrapolationGuard: { radiusCells: 8, penalty: 0.5 },
  });
  warnings.push(...dtm.warnings);

  // Elevation range over covered cells (drives gating + styling).
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < dtm.z.length; i++) {
    if (dtm.coverage[i] === 0 || !Number.isFinite(dtm.z[i])) continue;
    if (dtm.z[i] < minZ) minZ = dtm.z[i];
    if (dtm.z[i] > maxZ) maxZ = dtm.z[i];
  }
  const elevationRangeM = Number.isFinite(minZ) ? maxZ - minZ : 0;

  // 4) Validation + calibration.
  const validation = holdoutValidateDtm(groundPts, gf.isGround, {
    cellSizeM: params.cellSizeM,
    seed: params.holdoutSeed ?? 1,
    verticalAxis,
    isGeographic: params.isGeographic,
    verticalUnitToMetres: params.verticalUnitToMetres,
    collectSamples: true,
  });
  const calibration = checkCalibration(validation);
  const accuracy = computeVerticalAccuracy(validation);

  // 4b) Recalibrate the reported confidence against measured error, so a
  // cell's % means "probability the height is within τ of truth" rather
  // than a bare heuristic. τ is the measured RMSE. When there isn't
  // enough held-out evidence the fit is not assessable and the grid is
  // left untouched — we never synthesise a calibration from noise.
  const confidenceCalibration = fitConfidenceCalibration(validation.samples ?? [], {
    toleranceM: Number.isFinite(validation.rmse) && validation.rmse > 0 ? validation.rmse : null,
  });
  if (confidenceCalibration.assessable) {
    dtm = applyConfidenceCalibration(dtm, confidenceCalibration);
  }
  const confidenceCalibrationApplied = confidenceCalibration.assessable;
  const confidenceToleranceM = confidenceCalibration.assessable
    ? confidenceCalibration.toleranceM
    : null;

  // 5) Gate intervals against the measured RMSE. The gate is a function of
  // cell size, relief and the measured RMSE only — NOT of the chosen interval
  // — so it is part of the cacheable core. (The interval CHOICE happens in the
  // contour stage.)
  const gate = elevationRangeM > 0
    ? gateIntervals({
        cellSizeM: params.cellSizeM,
        elevationRangeM,
        rmseM: Number.isFinite(validation.rmse) ? validation.rmse : null,
      })
    : EMPTY_GATE;

  // 5b) DTM cell status, the quality gate (ready / previewOnly / blocked).
  // The gate decides whether the UI may offer a professional export at all.
  const cellStatusTally = tallyCellStatus(classifyCellStatus(dtm));
  const groundPointRatio =
    gf.sourcePointCount > 0 ? gf.groundPointCount / gf.sourcePointCount : Number.NaN;
  const quality = evaluateDtmQuality({
    tally: cellStatusTally,
    meanCellConfidence: dtm.meanConfidence,
    holdoutRmseM: validation.rmse,
    groundPointRatio,
    coverageMode: dtm.coverageMode,
    crs,
    verticalDatum,
    recommendedIntervalM: gate.recommendedM,
  });

  // Composite 0–100 terrain quality score + the per-cell metric rollup it
  // draws on (density, completeness, edge risk). Complements the verdict.
  const cellMetrics = computeCellMetrics(dtm).summary;
  // Express the validated accuracy in ASPRS/USGS 3DEP terms (NVA, VVA, QL) so
  // the surface can be judged against recognised accuracy standards.
  const accuracyStandards = demAccuracyStandards(
    Number.isFinite(validation.rmse) ? validation.rmse : null,
    Number.isFinite(validation.p95) ? validation.p95 : null,
    cellMetrics.meanDensity,
  );
  const coveredCells =
    cellStatusTally.measured + cellStatusTally.interpolated +
    cellStatusTally.lowConfidence + cellStatusTally.edgeRisk;
  const qualityScore = terrainQualityScore({
    measuredOfCovered: coveredCells > 0 ? cellStatusTally.measured / coveredCells : 0,
    meanCellConfidence: Number.isFinite(dtm.meanConfidence) ? dtm.meanConfidence : 0,
    holdoutRmseM: Number.isFinite(validation.rmse) ? validation.rmse : null,
    groundPointRatio: Number.isFinite(groundPointRatio) ? groundPointRatio : null,
    edgeRiskRatio: cellMetrics.edgeRiskRatio,
    meanDensity: cellMetrics.meanDensity,
    cellSizeM: params.cellSizeM,
  });

  // Surface models — a top-surface DSM (all returns) on the DTM grid, the
  // height of everything above bare earth (canopy / buildings), and slope +
  // hillshade derived from the bare-earth DTM.
  // Skip the full-points DSM pass when the DTM has no covered cells — there is
  // nothing to model, and downstream stats handle the empty grid fine.
  const dsmGridSpec = {
    originH1: dtm.originH1, originH2: dtm.originH2,
    cols: dtm.cols, rows: dtm.rows, cellSizeM: dtm.cellSizeM,
  };
  const dtmHasCoverage = dtm.coverage.some((c) => c !== 0);
  const dsm = dtmHasCoverage
    ? buildDsm(points, { grid: dsmGridSpec, verticalAxis })
    : emptySurfaceGrid(dsmGridSpec);
  // Slope/hillshade divide ΔZ (metres) by the horizontal cell size; when the
  // frame is geographic that cell size is in degrees, so convert to metres to
  // keep the gradient dimensionless. Z-only products (DSM, height-above-ground)
  // need no such correction.
  const horizCellM = horizontalCellMetres(dtm.cellSizeM, params.isGeographic);
  // Compute the Horn slope/aspect ONCE and reuse it for the slope stats, the
  // hillshade, and the exposed relief grids — re-lighting the surface at a new
  // sun angle in the UI is then a cheap per-cell pass with no Horn recompute.
  const sa = hornSlopeAspect(dtm.z, dtm.cols, dtm.rows, horizCellM);
  const slopeDegField = new Float32Array(sa.slope.length);
  for (let i = 0; i < sa.slope.length; i++) {
    slopeDegField[i] = (Math.atan(sa.slope[i]) * 180) / Math.PI;
  }
  const surface = {
    dsm: surfaceStats(dsm),
    canopy: heightAboveGround(dsm, dtm.z, dtm.coverage),
    slope: slopeStats(slopeDegField, dtm.coverage),
    hillshade: shadeFromSlopeAspect(sa.slope, sa.aspect, dtm.coverage, dtm.cols, dtm.rows),
    // Cached gradient grids (slope tangent + aspect, radians) so the panel can
    // re-light a multi-directional or single-direction relief interactively.
    relief: { slope: sa.slope, aspect: sa.aspect },
  };

  return {
    dtm,
    validation,
    calibration,
    confidenceCalibrationApplied,
    confidenceToleranceM,
    quality,
    qualityScore,
    cellMetrics,
    excludedByClassification: classFilter.excludedCount,
    accuracyStandards,
    surface,
    cellStatusTally,
    gate,
    accuracy,
    elevationRangeM,
    minZ: Number.isFinite(minZ) ? minZ : Number.NaN,
    maxZ: Number.isFinite(maxZ) ? maxZ : Number.NaN,
    interpolation,
    despikeApplied,
    crs,
    verticalDatum,
    cellSizeM: params.cellSizeM,
    gridGeometry: {
      pointCount: gf.analyzedPointCount,
      widthM: dtm.cols * dtm.cellSizeM,
      depthM: dtm.rows * dtm.cellSizeM,
      reliefM: elevationRangeM,
    },
    coreWarnings: warnings,
  };
}

/**
 * Run the interval-DEPENDENT half of the pipeline against a precomputed
 * {@link TerrainCore}: choose the interval, then contours → stitch → style →
 * smooth → feature model → tally → labels, plus the requested-interval-aware
 * grid recommendation. Cheap — no DTM, validation or surface work is redone.
 *
 * Composes the full {@link AnalyseContoursResult} from the core + the contour
 * products, so the returned shape is identical to a single-pass run.
 * Deterministic.
 */
export function contoursFromCore(
  core: TerrainCore,
  intervalParams: IntervalContourParams = {},
): AnalyseContoursResult {
  const { crs, verticalDatum, cellSizeM, dtm, gate, minZ, maxZ } = core;
  // Whether contour smoothing will be applied this run (default on). Captured
  // once so the early-return path and the main path agree, and so the README's
  // provenance reflects the real decision rather than a constant.
  const smoothingApplied = intervalParams.smooth !== false;
  // Interval-dependent warnings are appended AFTER the core warnings so the
  // composed `warnings` array is in the same order as a single-pass run.
  const warnings: string[] = [...core.coreWarnings];

  // The grid + interval recommendation reads the requested interval, so it is
  // part of the interval stage (the geometry inputs come from the core).
  const gridRecommendation = recommendGrid({
    pointCount: core.gridGeometry.pointCount,
    widthM: core.gridGeometry.widthM,
    depthM: core.gridGeometry.depthM,
    reliefM: core.gridGeometry.reliefM,
    requestedIntervalM: intervalParams.intervalM ?? null,
  });

  // Choose the interval: explicit > recommended.
  const intervalM = intervalParams.intervalM ?? gate.recommendedM ?? null;
  if (intervalParams.intervalM == null && gate.recommendedM == null) {
    warnings.push('no reliable contour interval for this scan');
  }

  const generationParams: AnalyseGenerationParams = {
    interpolation: core.interpolation,
    smoothing: smoothingApplied,
    despike: core.despikeApplied,
  };

  // 6-10) Contours → stitch → style → model → tally.
  if (intervalM == null) {
    const emptyContours: ContourSet = {
      levels: [],
      intervalM: 0,
      crs,
      verticalDatum,
      minZ: Number.isFinite(minZ) ? minZ : Number.NaN,
      maxZ: Number.isFinite(maxZ) ? maxZ : Number.NaN,
      warnings: ['no interval chosen'],
    };
    return {
      dtm,
      validation: core.validation,
      calibration: core.calibration,
      confidenceCalibrationApplied: core.confidenceCalibrationApplied,
      confidenceToleranceM: core.confidenceToleranceM,
      quality: core.quality,
      qualityScore: core.qualityScore,
      cellMetrics: core.cellMetrics,
      surface: core.surface,
      excludedByClassification: core.excludedByClassification,
      accuracyStandards: core.accuracyStandards,
      cellStatusTally: core.cellStatusTally,
      gridRecommendation,
      gate,
      intervalM: null,
      contours: emptyContours,
      stitched: [],
      style: { levels: [], warnings: [] },
      model: buildFeatureModel([], [], {
        crs,
        verticalDatum,
        intervalM: 0,
        coverageMode: dtm.coverageMode,
      }),
      tally: tallyContourSet(emptyContours),
      labels: [],
      accuracy: core.accuracy,
      elevationRangeM: core.elevationRangeM,
      generationParams,
      warnings,
    };
  }

  const contours = contoursAt(dtm, { intervalM });
  warnings.push(...contours.warnings);
  let stitched = stitchContourSet(contours);

  const style = styleLevels(
    contours.levels.map((l) => l.value),
    { intervalM, indexEvery: intervalParams.indexEvery ?? 5 },
  );

  // Beauty: smooth high-confidence runs (honesty-preserving — the
  // smoother provably never moves a low-confidence vertex).
  if (smoothingApplied) {
    stitched = stitched.map((level) => ({
      value: level.value,
      polylines: level.polylines.map((poly) => chaikinSmooth(poly)),
    }));
  }

  const model = buildFeatureModel(stitched, style.levels, {
    crs,
    verticalDatum,
    intervalM,
    coverageMode: dtm.coverageMode,
  });
  const tally = tallyContourSet(contours);

  // Labels along index contours only.
  const indexValues = new Set(style.levels.filter((l) => l.isIndex).map((l) => l.value));
  const indexPolylines = stitched
    .filter((level) => indexValues.has(level.value))
    .flatMap((level) => level.polylines);
  const labels = placeLabels(indexPolylines, {
    spacingM: intervalParams.labelSpacingM ?? Math.max(cellSizeM * 25, 1),
  });

  return {
    dtm,
    validation: core.validation,
    calibration: core.calibration,
    confidenceCalibrationApplied: core.confidenceCalibrationApplied,
    confidenceToleranceM: core.confidenceToleranceM,
    quality: core.quality,
    qualityScore: core.qualityScore,
    cellMetrics: core.cellMetrics,
    surface: core.surface,
    excludedByClassification: core.excludedByClassification,
    accuracyStandards: core.accuracyStandards,
    cellStatusTally: core.cellStatusTally,
    gridRecommendation,
    gate,
    intervalM,
    contours,
    stitched,
    style,
    model,
    tally,
    labels,
    accuracy: core.accuracy,
    elevationRangeM: core.elevationRangeM,
    generationParams,
    warnings,
  };
}

/**
 * Run the full honest-contour pipeline on a point set. Composition of
 * {@link computeTerrainCore} (heavy, interval-independent) and
 * {@link contoursFromCore} (cheap, interval-dependent) so the result is
 * byte-identical to the original single-pass implementation.
 *
 * Accepts the preferred Float32Array of XYZ triples (zero-copy-friendly,
 * boxed once internally) or a `TerrainPoint[]`. Deterministic.
 */
export function analyseContours(
  input: TerrainPointInput,
  params: AnalyseContoursParams,
): AnalyseContoursResult {
  return contoursFromCore(computeTerrainCore(input, params), params);
}
