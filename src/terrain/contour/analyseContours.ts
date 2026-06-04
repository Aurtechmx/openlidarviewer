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

/** Options for {@link analyseContours}. */
export interface AnalyseContoursParams {
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
  /** Explicit contour interval; when omitted, the gate's recommendation is used. */
  readonly intervalM?: number;
  /** Every Nth contour is an index contour. Default 5. */
  readonly indexEvery?: number;
  /** Vertical axis of the source frame. Default 'z'. */
  readonly verticalAxis?: VerticalAxis;
  /**
   * Per-point ASPRS classification, index-aligned with `points`. When present,
   * vegetation / building / noise returns are dropped before ground filtering
   * so the bare-earth surface never anchors to canopy or rooftops. The DSM
   * (top surface, for above-ground height) still uses the full cloud.
   */
  readonly classification?: ReadonlyArray<number> | Uint8Array;
  /** ASPRS classes to exclude before ground filtering. Default veg/building/noise. */
  readonly excludeClasses?: ReadonlyArray<number>;
  /** Hold-out PRNG seed for reproducible validation. Default 1. */
  readonly holdoutSeed?: number;
  /** Smooth high-confidence contour runs (honesty-preserving). Default true. */
  readonly smooth?: boolean;
  /** Label spacing along index contours, source units. Default 25×cellSize. */
  readonly labelSpacingM?: number;
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
  readonly warnings: string[];
}

const EMPTY_GATE: IntervalGateResult = { options: [], recommendedM: null, warnings: [] };

/** Run the full honest-contour pipeline on a point set. Deterministic. */
export function analyseContours(
  points: ReadonlyArray<TerrainPoint>,
  params: AnalyseContoursParams,
): AnalyseContoursResult {
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
  let dtm = buildDtmGrid(workingRaster, {
    crs,
    verticalDatum,
    isGeographic: params.isGeographic,
    interpolation: 'geodesic',
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

  // 5) Gate intervals against the measured RMSE.
  const gate = elevationRangeM > 0
    ? gateIntervals({
        cellSizeM: params.cellSizeM,
        elevationRangeM,
        rmseM: Number.isFinite(validation.rmse) ? validation.rmse : null,
      })
    : EMPTY_GATE;

  // Choose the interval: explicit > recommended.
  const intervalM = params.intervalM ?? gate.recommendedM ?? null;
  if (params.intervalM == null && gate.recommendedM == null) {
    warnings.push('no reliable contour interval for this scan');
  }

  // 5b) DTM cell status, the quality gate (ready / previewOnly / blocked),
  // and a grid + interval recommendation. The gate decides whether the UI
  // may offer a professional export at all.
  const cellStatusTally = tallyCellStatus(classifyCellStatus(dtm));
  const groundPointRatio =
    gf.sourcePointCount > 0 ? gf.groundPointCount / gf.sourcePointCount : Number.NaN;
  const gridRecommendation = recommendGrid({
    pointCount: gf.analyzedPointCount,
    widthM: dtm.cols * dtm.cellSizeM,
    depthM: dtm.rows * dtm.cellSizeM,
    reliefM: elevationRangeM,
    requestedIntervalM: params.intervalM ?? null,
  });
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
      validation,
      calibration,
      confidenceCalibrationApplied,
      confidenceToleranceM,
      quality,
      qualityScore,
      cellMetrics,
      surface,
      excludedByClassification: classFilter.excludedCount,
      accuracyStandards,
      cellStatusTally,
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
      accuracy,
      elevationRangeM,
      warnings,
    };
  }

  const contours = contoursAt(dtm, { intervalM });
  warnings.push(...contours.warnings);
  let stitched = stitchContourSet(contours);

  const style = styleLevels(
    contours.levels.map((l) => l.value),
    { intervalM, indexEvery: params.indexEvery ?? 5 },
  );

  // Beauty: smooth high-confidence runs (honesty-preserving — the
  // smoother provably never moves a low-confidence vertex).
  if (params.smooth !== false) {
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
    spacingM: params.labelSpacingM ?? Math.max(params.cellSizeM * 25, 1),
  });

  return {
    dtm,
    validation,
    calibration,
    confidenceCalibrationApplied,
    confidenceToleranceM,
    quality,
    qualityScore,
    cellMetrics,
    surface,
    excludedByClassification: classFilter.excludedCount,
    accuracyStandards,
    cellStatusTally,
    gridRecommendation,
    gate,
    intervalM,
    contours,
    stitched,
    style,
    model,
    tally,
    labels,
    accuracy,
    elevationRangeM,
    warnings,
  };
}
