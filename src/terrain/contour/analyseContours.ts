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
import { rasterizeDtm, type DtmAggregation } from '../ground/rasterizeDtm';
import type { DtmGrid } from '../ground/cellConfidence';
import { buildSurfaceFromRaster, LIVE_INTERPOLATION } from '../ground/surfaceFromRaster';
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
  slopeStats,
  type SlopeStats,
  type HillshadeResult,
} from '../surface/hillshade';
import { getTerrainRasterEngine } from '../engine/TerrainRasterEngine';
import {
  horizontalCellMetresXY,
  cosLatitude,
  METRES_PER_DEGREE,
} from '../ground/horizontalScale';
import { excludeNonGroundClasses } from '../ground/classificationFilter';
import { holdoutValidateDtm } from '../validate/holdoutRmse';
import { splitReliability, type ReliabilitySplit } from '../validate/reliabilitySplit';
import { checkConfidenceOrdering } from '../validate/calibrationCheck';
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
import type { ConfidenceOrderingResult, ValidationReport } from '../validate/ValidationReport';
import { gateIntervals, type IntervalGateResult } from './intervalGate';
import { contoursAt, type ContourSet } from './contoursAt';
import { stitchContourSet, type StitchedLevel } from './stitchContours';
import { styleLevels, type ContourStyleResult } from './contourStyle';
import { buildFeatureModel, type ContourFeatureModel } from './contourFeatureModel';
import { tallyContourSet, type GradeTally } from './evidenceGrade';
import {
  applyContourShapeStyle,
  defaultContourShapeStyle,
  type ContourShapeStyle,
} from './contourShapeStyle';
import { placeLabels, type ContourLabel } from './labelPlacement';
import { computeVerticalAccuracy, type VerticalAccuracy } from '../validate/verticalAccuracy';
import {
  summariseTerrainComplexity,
  type TerrainComplexitySummary,
} from '../complexity/complexitySummary';

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
   * Representative latitude of the grid (its centre), in degrees, for a
   * geographic frame — the WORLD latitude (render-recentred local Y plus the
   * cloud's world origin), never the recentred local Y itself (which is ≈ 0,
   * silently degrading cos φ to 1). A degree of longitude spans
   * `METRES_PER_DEGREE·cos φ` metres, so slope/aspect/hillshade and per-cell
   * densities scale the E–W axis by cos φ — at 60° latitude an uncorrected
   * estimate overstates the E–W run ~2×. Null / omitted keeps the isotropic
   * (cos φ = 1) estimate; ignored entirely for projected frames.
   */
  readonly latitudeDeg?: number | null;
  /**
   * Metres per source vertical unit (1 for metre data, ~0.3048 for feet). The
   * hold-out RMSE is reported in metres using this, so the quality score and
   * the "Vertical RMSE … m" readout are correct for feet-based CRSs. Default 1.
   */
  readonly verticalUnitToMetres?: number;
  /**
   * Metres per source horizontal unit (1 for metre data, ~0.3048 for feet).
   * Densities, cell areas and slope runs are scaled by this so a feet-based
   * projected CRS reports genuine pts/m² and correct slope, mirroring
   * `verticalUnitToMetres` on the Z axis. Ignored when `isGeographic` (the
   * metres-per-degree scale is used instead). Default 1. */
  readonly horizontalUnitToMetres?: number;
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
  /**
   * Scan-points per analysed point — `totalPoints / sampledPoints` from the
   * gather that strided the cloud down to this input. Per-cell densities (and
   * the USGS Quality Level graded from them) are multiplied by this so they
   * describe the SCAN, not the subsample: a stride-50 gather otherwise reports
   * a density 50× too low and an unfairly failing QL. Default 1 (input is the
   * full cloud, or the stride is unknown — density then describes the analysed
   * sample only). Coverage/confidence/RMSE are NOT scaled: they genuinely
   * measure the analysed points.
   */
  readonly samplePointScale?: number;
  /**
   * True when the analysed points are the currently-resident subset of a
   * still-streaming cloud (COPC/EPT), not the whole scan. The grid coverage
   * still reads 'full' (the resident nodes span the extent), but the DATA is
   * partial, so the surface coverageMode is reported as 'resident-only' and the
   * verdict reads "Preliminary" rather than a final 'Limited'. Default false.
   */
  readonly residentOnly?: boolean;
  /**
   * Per-cell aggregation for the LIVE DTM. Default `'median'` (see
   * {@link LIVE_DTM_AGGREGATION}): the 50th percentile is outlier-resistant, so
   * a single high (vegetation) or low (multipath) ground return in a cell no
   * longer drags the cell's elevation the way the arithmetic mean did. The
   * hold-out validation rebuilds its DTM with the SAME aggregation, so the
   * reported RMSE measures the surface the user actually receives.
   */
  readonly aggregation?: DtmAggregation;
}

/**
 * The per-cell aggregation the live pipeline uses for the delivered DTM.
 *
 * Switched mean → median as a robustness upgrade: the mean lets one outlier
 * ground return (a high vegetation hit or a low multipath blunder) pull a
 * cell's elevation, whereas the median (breakdown point 50 %) rejects it. The
 * hold-out validation rasterises with this same value so the validated surface
 * is byte-for-byte the surface that ships, and the DEM provenance reports it.
 */
const LIVE_DTM_AGGREGATION: DtmAggregation = 'median';

/**
 * Interval-dependent options for {@link contoursFromCore}. Re-picking any of
 * these is cheap because the core is reused unchanged.
 */
export interface IntervalContourParams {
  /** Explicit contour interval; when omitted, the gate's recommendation is used. */
  readonly intervalM?: number;
  /** Every Nth contour is an index contour. Default 5. */
  readonly indexEvery?: number;
  /**
   * Shape style for the exported contour geometry (honesty-gated). Default
   * `'smooth'` — which reproduces the historical Chaikin ×2 default exactly, so
   * the live on-screen contours are unchanged. Takes precedence over `smooth`.
   */
  readonly shapeStyle?: ContourShapeStyle;
  /**
   * Legacy boolean toggle for smoothing. Honoured for back-compat when
   * `shapeStyle` is not given: `false` ⇒ `'crisp'`, otherwise the default
   * `'smooth'`. Prefer `shapeStyle`.
   */
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
  /** The contour shape style applied to the exported geometry. */
  readonly contourStyle: ContourShapeStyle;
  /**
   * True when contour smoothing was applied. Derived as `style !== 'crisp'` and
   * kept for back-compat with any consumer that still reads a boolean.
   */
  readonly smoothing: boolean;
  /** True when the blunder-only despike pass ran before building the surface. */
  readonly despike: boolean;
  /** Per-cell aggregation the DTM raster was built with (e.g. `'median'`). */
  readonly aggregation: DtmAggregation;
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
  /**
   * Measured-cell empirical reliability (with a Wilson CI) kept separate from
   * interpolated-cell model support, at tolerance τ = the calibration
   * tolerance. Null when there was too little held-out evidence to state one.
   */
  readonly reliabilitySplit: ReliabilitySplit | null;
  /** Confidence→error ORDERING check (an honesty gate, not the PAV calibration). */
  readonly confidenceOrdering: ConfidenceOrderingResult;
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
  /**
   * Literature-defined terrain-complexity summary — VRM (Sappington et al.
   * 2007) median + IQR with its window, TPI (Weiss 2001) dominant slope-
   * position class with its radius, both with stated units and a derived
   * confidence. Null when nothing was measurable (no valid cells) — the UI
   * then renders an honest "—". Computed here, in the interval-independent
   * core (worker path), so it never runs on the interactive path.
   */
  readonly complexity: TerrainComplexitySummary | null;
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
  /** Per-cell aggregation the live + hold-out DTM rasters used (provenance). */
  readonly aggregation: DtmAggregation;
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
  /** Measured-cell empirical reliability (Wilson CI) vs interpolated model
   *  support, at τ = the calibration tolerance. Null when unstated. */
  readonly reliabilitySplit: ReliabilitySplit | null;
  /** Confidence→error ORDERING check (an honesty gate, not the PAV calibration). */
  readonly confidenceOrdering: ConfidenceOrderingResult;
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
  /**
   * Terrain-complexity summary (VRM median + IQR, TPI dominant class — with
   * windows, units, derived confidence, and caveats), or null when nothing
   * was measurable. Carried unchanged from the core (interval-independent).
   */
  readonly complexity: TerrainComplexitySummary | null;
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

  // A geographic frame with an unresolvable latitude proceeds with cos φ = 1
  // (no east–west correction) — a deliberate, honest fallback in
  // horizontalCellMetresXY, but one the user must SEE: away from the equator
  // the E–W cell span is overstated by 1/cos φ, skewing slope, aspect, area
  // and density. Push it into result.warnings instead of degrading silently.
  if (params.isGeographic && (params.latitudeDeg == null || !Number.isFinite(params.latitudeDeg))) {
    warnings.push(
      'Geographic frame with latitude unknown — the east–west scale is ' +
        'uncorrected (cos φ = 1), so slope/aspect/area derivatives are ' +
        'approximate away from the equator.',
    );
  }

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
  // The live surface aggregates each cell by MEDIAN (the robustness upgrade over
  // the old mean): a lone high/low ground return no longer pulls the cell. The
  // hold-out validation below rebuilds with this SAME aggregation, so the RMSE
  // measures the delivered surface, and the DEM provenance reports it.
  const aggregation: DtmAggregation = params.aggregation ?? LIVE_DTM_AGGREGATION;
  const raster = rasterizeDtm(groundPts, gf.isGround, {
    grid: {
      originH1: gf.originH1,
      originH2: gf.originH2,
      cols: gf.cols,
      rows: gf.rows,
      cellSizeM: params.cellSizeM,
    },
    aggregation,
    verticalAxis,
  });
  // 2b + 3) DTM hardening (blunder-only despike with the 2 % safety cap) +
  // geodesic void fill + extrapolation-guarded confidence — all through the
  // ONE shared raster→grid constructor, so the hold-out validation below
  // provably builds the SAME kind of surface (it calls the same function).
  // The despike pass is part of every generation run; the README derives its
  // provenance from this fact, not a mirrored constant.
  const despikeApplied = true;
  const built = buildSurfaceFromRaster(raster, {
    crs,
    verticalDatum,
    isGeographic: params.isGeographic,
    // WORLD grid-centre latitude for the confidence roughness slope's cos φ
    // E–W correction (the grid's own originH2 is render-recentred, ≈ 0).
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
  });
  if (built.despikedCellCount > 0) {
    warnings.push(`Removed ${built.despikedCellCount} outlier ground cell(s) before building the surface.`);
  } else if (built.cappedOutlierCount > 0) {
    warnings.push(
      `Outlier detection flagged ${built.cappedOutlierCount} cells (> 2% of data) — left unchanged; the surface looks noisy rather than spiky.`,
    );
  }
  // Single source of truth for the void-fill method: the README's provenance
  // reads this back off the result, so it can't drift from what actually ran.
  const interpolation: 'idw' | 'geodesic' = LIVE_INTERPOLATION;
  let dtm = built.dtm;
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
    // Validate the SAME surface the user gets: same per-cell aggregation as the
    // live DTM above (median), so the RMSE isn't measuring a different surface.
    aggregation,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    verticalUnitToMetres: params.verticalUnitToMetres,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
    collectSamples: true,
  });
  const confidenceOrdering = checkConfidenceOrdering(validation);
  const accuracy = computeVerticalAccuracy(validation);

  // Measured-cell empirical reliability (Wilson CI) kept separate from
  // interpolated-cell model support, at τ = the measured RMSE. Only stated when
  // there is real held-out evidence and a finite τ; a void has no truth to test.
  const reliabilityTolerance =
    Number.isFinite(validation.rmse) && validation.rmse > 0 ? validation.rmse : null;
  const reliabilitySplit: ReliabilitySplit | null =
    reliabilityTolerance !== null && validation.samples && validation.samples.length > 0
      ? splitReliability(
          validation.samples
            .filter((s) => s.zone !== undefined)
            .map((s) => ({ absError: s.absError, zone: s.zone as 'measured' | 'interpolated' })),
          reliabilityTolerance,
        )
      : null;

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
  // A still-streaming cloud is analysed on only its resident nodes. The raster
  // coverage reads 'full' (those nodes span the extent), but the DATA is a
  // partial, coarse subsample — so stamp the surface coverage as 'resident-only'
  // here, once, before the gate / quality / result / export model all read
  // dtm.coverageMode. This is what lets the assessment render a "Preliminary"
  // partial-stream verdict instead of a final 'Limited' on a scan that is still
  // loading. (Re-running once fully streamed gathers a non-resident set, so the
  // override no longer applies and the real grade shows.)
  if (params.residentOnly && dtm.coverageMode === 'full') {
    dtm = { ...dtm, coverageMode: 'resident-only' };
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
        // Real bounds unlock the EXACT level-crossing test for the coarse-
        // interval rule (a 1 m interval on a 0.4–1.2 m surface crosses 1.0).
        minZ: Number.isFinite(minZ) ? minZ : null,
        maxZ: Number.isFinite(maxZ) ? maxZ : null,
      })
    : EMPTY_GATE;

  // 5b) DTM cell status, the quality gate (ready / previewOnly / blocked).
  // The gate decides whether the UI may offer the terrain-product (contour/DEM) export at all.
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
  // Effective metres per horizontal unit: metres-per-degree for a geographic
  // frame, else the projected unit scale (1 for metres, ~0.3048 for feet). Feeds
  // the density (pts/m²) through the cell AREA, which cellMetrics computes as
  // this scale SQUARED — so for a geographic frame we fold the cos φ
  // anisotropy in as √(cos φ): area = (cell·M·cos φ)·(cell·M) = (cell·M·√cos φ)²
  // exactly. Without it a 60°-latitude scan reports ~half the true pts/m² and
  // an unfairly failing USGS QL. cos φ = 1 (no-op) when latitude is unknown.
  const horizUnitToMetres = params.isGeographic
    ? METRES_PER_DEGREE * Math.sqrt(cosLatitude(params.latitudeDeg))
    : params.horizontalUnitToMetres && params.horizontalUnitToMetres > 0
      ? params.horizontalUnitToMetres
      : 1;
  const cellMetrics = computeCellMetrics(dtm, {
    horizontalUnitToMetres: horizUnitToMetres,
    // Stride honesty: scale per-cell counts back to the SCAN so the density —
    // and the USGS QL graded from it below — describe the survey, not the
    // analysed subsample (see TerrainCoreParams.samplePointScale).
    countScale: params.samplePointScale,
  }).summary;
  // Express the validated accuracy in ASPRS/USGS 3DEP terms (NVA, VVA, QL) so
  // the surface can be judged against recognised accuracy standards.
  const accuracyStandards = demAccuracyStandards(
    Number.isFinite(validation.rmse) ? validation.rmse : null,
    Number.isFinite(validation.p95) ? validation.p95 : null,
    cellMetrics.meanDensity,
  );
  // Stride honesty: when the gather strided the cloud, the ground density (and
  // therefore the USGS 3DEP Quality Level graded from it) is a uniform-stride
  // extrapolation from the analysed subsample up to the full scan, NOT a
  // directly counted figure. Surface that the same way the space-scan path
  // does, so the density-derived QL is never read as an exact, directly-counted
  // grade. Only when striding actually happened (scale > 1) and a density-based
  // grade was assigned.
  const densityScale =
    Number.isFinite(params.samplePointScale) && (params.samplePointScale as number) > 1
      ? (params.samplePointScale as number)
      : 1;
  if (densityScale > 1 && cellMetrics.meanDensity > 0) {
    warnings.push(
      'Ground density is scaled from the analysed sample to the full scan ' +
        '(uniform-stride assumption); the USGS 3DEP Quality Level is graded ' +
        'from that scaled density, not a directly counted one.',
    );
  }
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
  // keep the gradient dimensionless. Per-axis: a degree of longitude spans
  // cos φ fewer metres than a degree of latitude, so the E–W run gets the
  // cos φ-corrected scale (projected frames return two identical values and
  // are byte-identical to the old single-scale path). Z-only products (DSM,
  // height-above-ground) need no such correction.
  const { x: horizCellEwM, y: horizCellNsM } = horizontalCellMetresXY(
    dtm.cellSizeM,
    params.isGeographic,
    params.latitudeDeg,
    params.horizontalUnitToMetres,
  );
  // Compute the Horn slope/aspect ONCE and reuse it for the slope stats, the
  // hillshade, and the exposed relief grids — re-lighting the surface at a new
  // sun angle in the UI is then a cheap per-cell pass with no Horn recompute.
  //
  // The derivative stage routes through the TerrainRasterEngine seam. This
  // synchronous pipeline uses the engine's SYNC entries — the CPU REFERENCE
  // path, pure delegation to hornSlopeAspect / shadeFromSlopeAspect, so the
  // output is byte-identical to calling them directly. The engine's async
  // entries are the GPU-eligible ones (per-session equivalence probe,
  // auto-fallback); the pipeline adopts them when this stage goes async.
  const engine = getTerrainRasterEngine();
  const sa = engine.derivativesSync(dtm.z, dtm.cols, dtm.rows, horizCellEwM, horizCellNsM);
  const slopeDegField = new Float32Array(sa.slope.length);
  for (let i = 0; i < sa.slope.length; i++) {
    slopeDegField[i] = (Math.atan(sa.slope[i]) * 180) / Math.PI;
  }
  const surface = {
    dsm: surfaceStats(dsm),
    canopy: heightAboveGround(dsm, dtm.z, dtm.coverage),
    slope: slopeStats(slopeDegField, dtm.coverage),
    hillshade: engine.hillshadeSync(sa.slope, sa.aspect, dtm.coverage, dtm.cols, dtm.rows),
    // Cached gradient grids (slope tangent + aspect, radians) so the panel can
    // re-light a multi-directional or single-direction relief interactively.
    relief: { slope: sa.slope, aspect: sa.aspect },
  };

  // Terrain-complexity summary (VRM per Sappington et al. 2007, TPI per
  // Weiss 2001) over the SAME Horn grids and coverage mask the surface
  // models use — nothing is recomputed, and the summary rides the core so
  // it is computed off the interactive path (worker or fallback), never
  // eagerly at attach. The scan-scaled ground density feeds the cited
  // ≥4 pts/m² reliability caveat (Münzinger et al. 2022); null when the
  // grid had nothing measurable, which downstream renders as "—".
  const complexity = dtmHasCoverage
    ? summariseTerrainComplexity({
        z: dtm.z,
        coverage: dtm.coverage,
        cols: dtm.cols,
        rows: dtm.rows,
        slope: sa.slope,
        aspect: sa.aspect,
        cellMetresX: horizCellEwM,
        cellMetresY: horizCellNsM,
        verticalUnitToMetres: params.verticalUnitToMetres,
        meta: {
          coverage: dtm.coverageMode,
          sourcePointCount: dtm.sourcePointCount,
          analyzedPointCount: dtm.analyzedPointCount,
        },
        groundDensityPerM2: cellMetrics.meanDensity,
      })
    : null;

  return {
    dtm,
    validation,
    reliabilitySplit,
    confidenceOrdering,
    confidenceCalibrationApplied,
    confidenceToleranceM,
    quality,
    qualityScore,
    cellMetrics,
    excludedByClassification: classFilter.excludedCount,
    accuracyStandards,
    surface,
    cellStatusTally,
    complexity,
    gate,
    accuracy,
    elevationRangeM,
    minZ: Number.isFinite(minZ) ? minZ : Number.NaN,
    maxZ: Number.isFinite(maxZ) ? maxZ : Number.NaN,
    interpolation,
    aggregation,
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
  // The contour shape style for this run. Default 'smooth' reproduces the
  // historical Chaikin ×2 default exactly, so the live on-screen contours are
  // byte-identical. `shapeStyle` wins; otherwise the legacy `smooth:false`
  // boolean maps to 'crisp'. Captured once so every path agrees and the README
  // provenance reflects the real decision.
  const shapeStyle: ContourShapeStyle =
    intervalParams.shapeStyle ??
    (intervalParams.smooth === false ? 'crisp' : defaultContourShapeStyle);
  // Back-compat boolean: anything but raw geometry counts as "smoothed".
  const smoothingApplied = shapeStyle !== 'crisp';
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
    contourStyle: shapeStyle,
    smoothing: smoothingApplied,
    despike: core.despikeApplied,
    aggregation: core.aggregation,
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
      reliabilitySplit: core.reliabilitySplit,
      confidenceOrdering: core.confidenceOrdering,
      confidenceCalibrationApplied: core.confidenceCalibrationApplied,
      confidenceToleranceM: core.confidenceToleranceM,
      quality: core.quality,
      qualityScore: core.qualityScore,
      cellMetrics: core.cellMetrics,
      surface: core.surface,
      excludedByClassification: core.excludedByClassification,
      accuracyStandards: core.accuracyStandards,
      cellStatusTally: core.cellStatusTally,
      complexity: core.complexity,
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
        contourStyle: shapeStyle,
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
  // Cell-size-aware endpoint quantum: the fixed 1 mm key is ≈111 m in a
  // degree-denominated frame and would weld a fine geographic grid's
  // contours into one blob; scaling by the cell keeps the join unit-free.
  let stitched = stitchContourSet(contours, cellSizeM);

  const style = styleLevels(
    contours.levels.map((l) => l.value),
    { intervalM, indexEvery: intervalParams.indexEvery ?? 5 },
  );

  // Beauty: apply the chosen shape style to the raw stitched runs. Every style
  // is honesty-gated (the smoother/simplifier provably never move a low-
  // confidence vertex or bridge a gap). 'crisp' is identity; 'smooth' (default)
  // is exactly the historical Chaikin ×2, so the live contours are unchanged.
  stitched = stitched.map((level) => ({
    value: level.value,
    polylines: applyContourShapeStyle(level.polylines, shapeStyle, { cellSizeM }),
  }));

  const model = buildFeatureModel(stitched, style.levels, {
    crs,
    verticalDatum,
    intervalM,
    coverageMode: dtm.coverageMode,
    contourStyle: shapeStyle,
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
    reliabilitySplit: core.reliabilitySplit,
    confidenceOrdering: core.confidenceOrdering,
    confidenceCalibrationApplied: core.confidenceCalibrationApplied,
    confidenceToleranceM: core.confidenceToleranceM,
    quality: core.quality,
    qualityScore: core.qualityScore,
    cellMetrics: core.cellMetrics,
    surface: core.surface,
    excludedByClassification: core.excludedByClassification,
    accuracyStandards: core.accuracyStandards,
    cellStatusTally: core.cellStatusTally,
    complexity: core.complexity,
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
