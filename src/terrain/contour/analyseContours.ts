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
  groundFromTrustedClassification,
  type GroundFilterParams,
  type GroundFilterResult,
  type VerticalAxis,
} from '../ground/groundFilter';
import { rasterizeDtm, type DtmAggregation } from '../ground/rasterizeDtm';
import { synthesisedNeighbourMask } from '../ground/terrainDerivatives';
import type { DtmGrid } from '../ground/cellConfidence';
import { buildSurfaceFromRaster, LIVE_INTERPOLATION } from '../ground/surfaceFromRaster';
import { LIVE_DTM_AGGREGATION, ASPRS_GROUND_CLASS } from '../ground/liveDtmConstants';
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
import { makeTrainOnlyReclassifier } from '../validate/trainOnlyReclassify';
import { splitReliability, type ReliabilitySplit } from '../validate/reliabilitySplit';
import { spatialBlockHoldout, type SpatialBlockResult } from '../validate/spatialBlockHoldout';
import { DtmSurfaceModel } from '../validate/dtmSurfaceModel';
import { axisGetters } from '../ground/axisGetters';
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
  GENERALIZE_EPS_CELLS,
  type ContourShapeStyle,
} from './contourShapeStyle';
import type { ContourGeneralizeMode } from './terrainAwareTolerance';
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
  /**
   * Ground-filter overrides (sensible defaults otherwise). Cell sizing stays
   * pipeline-owned: `cellSizeZUnits` is derived from `cellSizeM` and the CRS
   * units in {@link resolveGroundFilterParams}, never caller-supplied.
   */
  readonly ground?: Partial<
    Omit<GroundFilterParams, 'cellSizeM' | 'cellSizeZUnits' | 'verticalAxis'>
  >;
  /** Horizontal CRS (required for usable exports; warns when null). */
  readonly crs?: string | null;
  /** Numeric EPSG codes from the resolver — see DtmGrid. */
  horizontalEpsg?: number | null;
  verticalEpsg?: number | null;
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
  /**
   * Trust an authoritative ground classification instead of re-deriving one
   * with SMRF. When the caller already carries a usable ASPRS class-2 (ground)
   * set — a survey-delivered bare-earth cloud, or the lasso editor's ground
   * assignment — the DTM should be rasterised straight from those points, so
   * every ground node is a MEASURED cell and steep-slope ground SMRF's
   * progressive opening would drop stays exact. Interpreted as:
   *   - `true`  — force trust: use the class-2 points as the ground set and
   *               skip SMRF (falls back to SMRF with a warning if no class-2
   *               points are present).
   *   - `false` — never trust: always run SMRF (the historical behaviour).
   *   - omitted — AUTO: trust only when a class-2 set of sufficient size is
   *               present AND every ground candidate (after dropping
   *               vegetation/building/noise) is class-2, i.e. the cloud is
   *               fully ground-classified. This keeps mixed clouds (some
   *               unclassified ground) on the SMRF path, so unclassified
   *               ground is never silently dropped.
   * The RAW-cloud path (no `classification`) is byte-unchanged: with no
   * classification there is no class-2 set, so auto never engages.
   */
  readonly trustGroundClassification?: boolean;
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
// Sourced from the shared, dependency-free constants module so the method
// descriptor (`science/liveDtmDescriptor`) reads the SAME literal without
// importing this heavy pipeline. See {@link LIVE_DTM_AGGREGATION}.

/**
 * Fraction of derivative cells built on a synthesised neighbour above which the
 * surface stage says so out loud.
 *
 * Not zero, deliberately. EVERY raster has an outer ring, so an unconditional
 * warning would fire on every scan and carry no information; on a 1000x1000 grid
 * the ring really is 0.4% and saying so would be noise. It stops being noise on a
 * small or void-riddled grid, where a visible share of the slope, aspect and
 * hillshade is estimated rather than measured. 5% is the point at which the ring
 * (or a hole halo) is a twentieth of the product — roughly a grid under 80 cells
 * on a side, or any grid with appreciable voids.
 */
const SYNTHESISED_WARN_FRACTION = 0.05;

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
   * Generalization strength for the 'generalized' shape style, as a fraction of
   * the grid cell (the Douglas–Peucker epsilon is `generalizeToleranceCells ×
   * cell`). Contour Studio purposes set this per purpose so each deliverable
   * generalises at its own bounded tolerance (Survey exact = crisp, Terrain
   * Research light, Engineering moderate, Presentation strong). Ignored for every
   * style but 'generalized'; when omitted the default 0.5 is used, so callers that
   * never set it are byte-unchanged.
   */
  readonly generalizeToleranceCells?: number;
  /**
   * How the 'generalized' style distributes its tolerance across features:
   * 'uniform' (default when omitted, byte-unchanged) or 'terrain-aware' (scaled
   * DOWN per feature, never up). Ignored for every style but 'generalized'.
   */
  readonly generalizeMode?: ContourGeneralizeMode;
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
   * Generalization tolerance actually used (cells) for the 'generalized' style —
   * the Douglas–Peucker epsilon as a fraction of the cell size. Null for every
   * other style (crisp/smooth/rounded/semi-geometric do not run the per-purpose
   * generalize pass). Recorded from the real generation config so export
   * provenance names the exact tolerance a deliverable was simplified at, and can
   * never drift from the geometry that shipped.
   */
  readonly generalizeToleranceCells?: number | null;
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
  /**
   * Spatially-blocked hold-out RMSE (in metres) with a bootstrap CI — a less
   * optimistic accuracy estimate than the random point hold-out, since it
   * predicts across whole withheld blocks. Null when skipped (grid too large
   * to afford the k rebuilds, or too few blocks to split). Diagnostic, not
   * field accuracy.
   */
  readonly blockedAccuracy: SpatialBlockResult | null;
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
    readonly relief: {
      readonly slope: Float32Array;
      readonly aspect: Float32Array;
      /** 1 where the Horn window used a synthesised neighbour (outer ring, or a
       *  hole halo). See `synthesisedNeighbourMask` in ground/terrainDerivatives. */
      readonly synthesised: Uint8Array;
    };
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
  /**
   * Metres per source vertical unit, echoed for the contour stage: DTM
   * elevations (and therefore contour values) are in source units, so an
   * exporter naming that unit needs the factor. Null when unresolved.
   */
  readonly verticalUnitToMetres: number | null;
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
  /** Spatially-blocked hold-out RMSE (metres) + bootstrap CI, or null when
   *  skipped. A less optimistic accuracy estimate than the random hold-out. */
  readonly blockedAccuracy: SpatialBlockResult | null;
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
    readonly relief: {
      readonly slope: Float32Array;
      readonly aspect: Float32Array;
      /** 1 where the Horn window used a synthesised neighbour (outer ring, or a
       *  hole halo). See `synthesisedNeighbourMask` in ground/terrainDerivatives. */
      readonly synthesised: Uint8Array;
    };
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
  /**
   * The interval of the contour levels actually emitted. Coarser than
   * {@link requestedIntervalM} when an over-fine request was thinned.
   */
  readonly intervalM: number | null;
  /** The interval that was requested (explicit or gate-recommended). */
  readonly requestedIntervalM: number | null;
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

/** ASPRS classification code for bare-earth ground returns. */
// ASPRS ground code — see the shared constants module (re-imported above).

/**
 * Minimum class-2 points for AUTO trust to engage — enough to hold-out
 * cross-validate (which needs ≥ 4 ground returns to split). Below this the
 * classification is too sparse to be the authoritative surface, so the SMRF
 * path runs. `trustGroundClassification: true` bypasses this floor.
 */
const AUTO_TRUST_MIN_GROUND_POINTS = 4;

/** Resolved trust decision + the class-2 ground point set it will use. */
interface GroundTrustDecision {
  /** True when the DTM should be built from the class-2 set, skipping SMRF. */
  readonly trust: boolean;
  /** The ASPRS class-2 (ground) points, index-selected from the input. */
  readonly groundPoints: TerrainPoint[];
  /** True when trust was explicitly requested but no class-2 points exist. */
  readonly requestedButUnavailable: boolean;
}

/**
 * Decide whether to trust an existing ground classification (see
 * {@link TerrainCoreParams.trustGroundClassification}) and, when so, select the
 * class-2 point set to rasterise the DTM from.
 *
 * `keptCandidateCount` is the number of points that survive
 * {@link excludeNonGroundClasses} (the 0/1/2/9 ground candidates). AUTO trust
 * requires EVERY candidate to be class-2, so a cloud with unclassified ground
 * stays on the SMRF path and nothing is silently dropped.
 */
function resolveGroundTrust(
  points: ReadonlyArray<TerrainPoint>,
  classification: ReadonlyArray<number> | Uint8Array | undefined,
  keptCandidateCount: number,
  explicit: boolean | undefined,
): GroundTrustDecision {
  const aligned = classification != null && classification.length === points.length;
  const groundPoints: TerrainPoint[] = [];
  if (aligned) {
    for (let i = 0; i < points.length; i++) {
      if (classification![i] === ASPRS_GROUND_CLASS) groundPoints.push(points[i]);
    }
  }
  const class2Count = groundPoints.length;

  if (explicit === false) {
    return { trust: false, groundPoints: [], requestedButUnavailable: false };
  }
  if (explicit === true) {
    if (class2Count >= 1) return { trust: true, groundPoints, requestedButUnavailable: false };
    return { trust: false, groundPoints: [], requestedButUnavailable: true };
  }
  // AUTO: a class-2 set of sufficient size, and the classification is
  // authoritative (every ground candidate is class-2).
  const auto =
    class2Count >= AUTO_TRUST_MIN_GROUND_POINTS && class2Count === keptCandidateCount;
  return {
    trust: auto,
    groundPoints: auto ? groundPoints : [],
    requestedButUnavailable: false,
  };
}

/**
 * Resolve the ground-filter parameters the core actually runs with (caller
 * overrides + pipeline defaults). Exported as the SINGLE source of truth for
 * both the main classification pass and the hold-out validation's train-only
 * reclassifier — sharing one resolved object is what makes parameter drift
 * between the delivered surface and the validated one structurally
 * impossible (and lets tests mirror the exact shipped parameters).
 */
export function resolveGroundFilterParams(
  params: TerrainCoreParams,
  verticalAxis: VerticalAxis,
): GroundFilterParams {
  // The SMRF slope-scaled threshold multiplies a rise/run by the horizontal
  // cell run and compares the product against Δz, so that run must be handed
  // over in z's unit. Convert at this seam (metres per horizontal unit over
  // metres per vertical unit) — the same convert-at-the-boundary rule the
  // epoch alignment applies to ICP's metre-denominated gate. When both axes
  // share one linear unit the ratio is exactly 1 and the filter sees the
  // plain cell size; a geographic frame's degree-valued cell would otherwise
  // starve the growth term by ~1/111,320, pinning the threshold at its base
  // and rejecting legitimate slope ground.
  let horizToMetres: number;
  if (params.isGeographic) {
    horizToMetres = METRES_PER_DEGREE;
  } else if (params.horizontalUnitToMetres && params.horizontalUnitToMetres > 0) {
    horizToMetres = params.horizontalUnitToMetres;
  } else {
    horizToMetres = 1;
  }
  const vertToMetres =
    params.verticalUnitToMetres && params.verticalUnitToMetres > 0
      ? params.verticalUnitToMetres
      : 1;
  // The SMRF tolerances are physical constants (0.5 m base, 2.5 m cap; Pingel
  // et al. 2013) but the filter compares them against source-unit Δz, so convert
  // metres → source vertical units here. On a foot frame a 0.5 m base tolerance
  // is 1.64 ft; left as 0.5 source-ft (0.15 m) it rejects real ground and warps
  // the DTM for the same physical terrain. The ratio is exactly 1 for a metre
  // frame, so metric clouds are unchanged.
  const zPerMetre = 1 / vertToMetres;
  return {
    cellSizeM: params.cellSizeM,
    cellSizeZUnits: params.cellSizeM * (horizToMetres / vertToMetres),
    maxWindowCells: params.ground?.maxWindowCells ?? 8,
    slope: params.ground?.slope ?? 0.2,
    elevationThresholdM: (params.ground?.elevationThresholdM ?? 0.5) * zPerMetre,
    maxElevationThresholdM:
      (params.ground?.maxElevationThresholdM ?? 2.5) * zPerMetre,
    scalingFactorM:
      params.ground?.scalingFactorM != null
        ? params.ground.scalingFactorM * zPerMetre
        : undefined,
    // Despike by default in the pipeline (the leaf stays strict-min).
    floorPercentile: params.ground?.floorPercentile ?? 5,
    verticalAxis,
  };
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
/**
 * Options for the DtmSurfaceModel the spatially-blocked hold-out rebuilds its
 * fold surfaces with.
 *
 * Exported as a pure seam so a test can pin the invariant dtmSurfaceModel.ts
 * states in caps: the validator MUST be handed the SAME `despike` and
 * `verticalUnitToMetres` the shipped surface used, or every fold scores a
 * surface the viewer never delivered. The trusted class-2 path turns the
 * despike OFF because a steep survey node is data, not a blunder, and the
 * vertical scale sizes the despike floor and the confidence roughness on
 * foot-vertical scans. A statistic cannot guard this: geometry the despike
 * would remove is also geometry a held-out block cannot predict, so the two
 * effects are confounded in any end-to-end RMSE.
 */
export function blockedHoldoutModelOptions(
  dtm: { originH1: number; originH2: number; cols: number; rows: number; cellSizeM: number },
  aggregation: DtmAggregation,
  despikeApplied: boolean,
  params: Pick<
    TerrainCoreParams,
    'isGeographic' | 'latitudeDeg' | 'horizontalUnitToMetres' | 'verticalUnitToMetres'
  >,
): ConstructorParameters<typeof DtmSurfaceModel>[0] {
  return {
    grid: {
      originH1: dtm.originH1,
      originH2: dtm.originH2,
      cols: dtm.cols,
      rows: dtm.rows,
      cellSizeM: dtm.cellSizeM,
    },
    aggregation,
    despike: despikeApplied,
    verticalUnitToMetres: params.verticalUnitToMetres,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
  };
}

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
  let groundPts: ReadonlyArray<TerrainPoint> = classFilter.points;
  if (classFilter.excludedCount > 0) {
    warnings.push(
      `Excluded ${classFilter.excludedCount} classified vegetation/building/noise return(s) before ground filtering.`,
    );
  }

  // 1) Ground classification. The resolved parameters are built ONCE (see
  // resolveGroundFilterParams) and shared with the hold-out validation's
  // train-only reclassifier below, so the per-split classification can never
  // drift from the pass that produced the delivered surface.
  //
  // When a usable ground classification is present (auto) — or the caller
  // forces it — TRUST the ASPRS class-2 set as the surface and skip the SMRF
  // re-derivation: the DTM is then rasterised straight from measured ground
  // returns, so steep-slope ground SMRF's progressive opening would discard
  // stays exact. `reclassifyForHoldout` follows the same decision so the
  // hold-out validates the surface the user actually receives.
  const groundParams = resolveGroundFilterParams(params, verticalAxis);
  const trust = resolveGroundTrust(
    points,
    params.classification,
    groundPts.length,
    params.trustGroundClassification,
  );
  if (trust.requestedButUnavailable) {
    warnings.push(
      'trustGroundClassification was requested but no ASPRS class 2 (ground) ' +
        'points are present; falling back to the SMRF ground filter.',
    );
  }
  let groundPtsForSurface: ReadonlyArray<TerrainPoint>;
  let gf: GroundFilterResult;
  let reclassifyForHoldout:
    | ((points: ReadonlyArray<TerrainPoint>, isHeldOut: Uint8Array) => Uint8Array | ReadonlyArray<number>)
    | undefined;
  if (trust.trust) {
    groundPtsForSurface = trust.groundPoints;
    gf = groundFromTrustedClassification(groundPtsForSurface, {
      cellSizeM: params.cellSizeM,
      verticalAxis,
    });
    warnings.push(...gf.warnings);
    warnings.push(
      `Trusted ${gf.groundPointCount} ASPRS class 2 (ground) point(s) as the DTM ` +
        'surface; SMRF ground re-derivation skipped (every ground node is a measured cell).',
    );
    // The class-2 set is authoritative and independent of the hold-out split,
    // so a withheld point never helped decide its own ground membership — the
    // classification leak the SMRF path removes with a re-run simply does not
    // exist here. Feed the validator an all-ground mask (it excludes held-out
    // points from the fit itself), so it validates the delivered surface.
    reclassifyForHoldout = (pts) => new Uint8Array(pts.length).fill(1);
  } else {
    groundPtsForSurface = groundPts;
    gf = classifyGroundSmrf(groundPtsForSurface, groundParams);
    warnings.push(...gf.warnings);
    reclassifyForHoldout = makeTrainOnlyReclassifier(groundParams);
  }
  // Every stage below that consumed `groundPts` reads the resolved surface set.
  groundPts = groundPtsForSurface;

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
  // The despike pass is part of every generation run EXCEPT the trusted-
  // classification path: there the ground returns are authoritative, so a
  // steep survey node must not be void-filled as a spike. The README derives
  // its provenance from this fact, not a mirrored constant.
  const despikeApplied = !trust.trust;
  const built = buildSurfaceFromRaster(raster, {
    crs,
    horizontalEpsg: params.horizontalEpsg,
    verticalDatum,
    verticalEpsg: params.verticalEpsg,
    despike: despikeApplied,
    isGeographic: params.isGeographic,
    // WORLD grid-centre latitude for the confidence roughness slope's cos φ
    // E–W correction (the grid's own originH2 is render-recentred, ≈ 0).
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
    verticalUnitToMetres: params.verticalUnitToMetres,
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
    // live DTM above (median) AND the same despike decision (off when trusting
    // the classification), so the RMSE isn't measuring a different surface.
    aggregation,
    despike: despikeApplied,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    verticalUnitToMetres: params.verticalUnitToMetres,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
    collectSamples: true,
    // Close the classify-before-split leak (disclosed since v0.5.9): re-run
    // the SAME classifier with the SAME resolved parameters on the training
    // points only, so a held-out point never helps decide its own ground
    // membership. The hook flips the report's disclosure automatically.
    // Cost: the hold-out is a single deterministic split, so this is exactly
    // ONE extra SMRF pass over the training share of the analysed cloud
    // (already capped by the gather stride) — ground-filter cost ≤ 2× per
    // run, never K passes. On the trusted-classification path this is instead
    // an all-ground mask (no SMRF), so the hold-out validates the exact class-2
    // surface the user receives.
    reclassifyGround: reclassifyForHoldout,
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

  // Spatially-blocked hold-out — a less optimistic accuracy estimate that
  // predicts across whole withheld blocks (see spatialBlockHoldout). It costs k
  // DTM rebuilds, so it is bounded: skipped on grids over CELL_CAP cells, and
  // the ground set is strided to POINT_CAP points. Diagnostic only; reported in
  // metres. Null when skipped or when there aren't enough blocks to split.
  const BLOCKED_CELL_CAP = 250_000; // ~500×500 grid
  const BLOCKED_POINT_CAP = 20_000;
  const vMetresB =
    Number.isFinite(params.verticalUnitToMetres) && (params.verticalUnitToMetres as number) > 0
      ? (params.verticalUnitToMetres as number)
      : 1;
  let blockedAccuracy: SpatialBlockResult | null = null;
  if (dtm.cols * dtm.rows <= BLOCKED_CELL_CAP) {
    const { getH1, getH2, getV } = axisGetters(verticalAxis);
    const groundXYZ: Array<{ x: number; y: number; z: number }> = [];
    for (let i = 0; i < groundPts.length; i++) {
      if (gf.isGround[i] !== 1) continue;
      const p = groundPts[i];
      if (!Number.isFinite(getH1(p)) || !Number.isFinite(getH2(p)) || !Number.isFinite(getV(p))) continue;
      groundXYZ.push({ x: getH1(p), y: getH2(p), z: getV(p) });
    }
    const stride = Math.max(1, Math.ceil(groundXYZ.length / BLOCKED_POINT_CAP));
    const sampled = stride > 1 ? groundXYZ.filter((_, i) => i % stride === 0) : groundXYZ;
    if (sampled.length >= 32) {
      const model = new DtmSurfaceModel(
        blockedHoldoutModelOptions(dtm, aggregation, despikeApplied, params),
      );
      const raw = spatialBlockHoldout(sampled, model, {
        blockSize: dtm.cellSizeM * 8,
        folds: 4,
        seed: params.holdoutSeed ?? 1,
      });
      // Scale residual-derived figures from source vertical units to metres.
      blockedAccuracy = {
        ...raw,
        rmse: raw.rmse * vMetresB,
        mae: raw.mae * vMetresB,
        ciLow: raw.ciLow * vMetresB,
        ciHigh: raw.ciHigh * vMetresB,
      };
    }
  }

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
        // UNIT CONSISTENCY: candidate intervals and the elevation range/bounds
        // are in the surface's SOURCE vertical units (contours draw against
        // `dtm.z`, which `contoursAt` uses raw). The hold-out RMSE is in METRES.
        // Feeding it raw made the "finer than 2×error" rule compare feet against
        // metres on foot-based data; express RMSE in the interval's own units.
        rmseM: Number.isFinite(validation.rmse) ? validation.rmse / vMetresB : null,
        // Real bounds unlock the EXACT level-crossing test for the coarse-
        // interval rule (a 1-unit interval on a 0.4–1.2-unit surface crosses 1.0).
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
  let horizUnitToMetres: number;
  if (params.isGeographic) {
    horizUnitToMetres = METRES_PER_DEGREE * Math.sqrt(cosLatitude(params.latitudeDeg));
  } else if (params.horizontalUnitToMetres && params.horizontalUnitToMetres > 0) {
    horizUnitToMetres = params.horizontalUnitToMetres;
  } else {
    horizUnitToMetres = 1;
  }
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
  // therefore the USGS 3DEP density reference derived from it) is a uniform-stride
  // extrapolation from the analysed subsample up to the full scan, NOT a
  // directly counted figure. Surface that the same way the space-scan path does,
  // so the density figure is never read as an exact, directly-counted one. Only
  // when striding actually happened (scale > 1) and a density was measured.
  const densityScale =
    Number.isFinite(params.samplePointScale) && (params.samplePointScale as number) > 1
      ? (params.samplePointScale as number)
      : 1;
  if (densityScale > 1 && cellMetrics.meanDensity > 0) {
    warnings.push(
      'Ground density is scaled from the analysed sample to the full scan ' +
        '(uniform-stride assumption); the USGS 3DEP density reference is derived ' +
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
  // `dtm.z` stays in native source vertical units (contours draw against it
  // raw), so the slope/aspect stage converts the rise with verticalUnitToMetres
  // to keep the rise/run ratio unit-consistent — a state-plane-feet DTM would
  // otherwise report slope ~1/0.3048 ≈ 3.28× too steep.
  const sa = engine.derivativesSync(
    dtm.z, dtm.cols, dtm.rows, horizCellEwM, horizCellNsM, params.verticalUnitToMetres,
  );
  const slopeDegField = new Float32Array(sa.slope.length);
  for (let i = 0; i < sa.slope.length; i++) {
    slopeDegField[i] = (Math.atan(sa.slope[i]) * 180) / Math.PI;
  }
  // Which derivative cells leaned on a value that was not measured there: the
  // outer ring, where a neighbour is extrapolated, plus any hole halo, where a
  // non-finite neighbour was replaced by the centre.
  const synthesised = synthesisedNeighbourMask(dtm.z, dtm.cols, dtm.rows);
  let synthesisedCount = 0;
  for (const flag of synthesised) synthesisedCount += flag;
  // Reported only when it is a material share of the grid — see
  // SYNTHESISED_WARN_FRACTION for why the threshold is not zero.
  if (synthesised.length > 0 && synthesisedCount / synthesised.length >= SYNTHESISED_WARN_FRACTION) {
    const pct = ((100 * synthesisedCount) / synthesised.length).toFixed(1);
    warnings.push(
      `Slope, aspect and hillshade on ${synthesisedCount} cell(s) (${pct}% of the grid) were computed ` +
      `using at least one synthesised neighbour — the raster's outer ring, where a neighbour is ` +
      `extrapolated, and any cell beside a void, where a missing neighbour falls back to the centre ` +
      `height. Those values are estimates, not measurements.`,
    );
  }
  const surface = {
    dsm: surfaceStats(dsm),
    canopy: heightAboveGround(dsm, dtm.z, dtm.coverage),
    slope: slopeStats(slopeDegField, dtm.coverage),
    hillshade: engine.hillshadeSync(sa.slope, sa.aspect, dtm.coverage, dtm.cols, dtm.rows),
    // Cached gradient grids (slope tangent + aspect, radians) so the panel can
    // re-light a multi-directional or single-direction relief interactively.
    // `synthesised` rides along so a consumer can tell a derivative computed
    // entirely from measured neighbours from one that leaned on an extrapolated
    // or substituted value — the products themselves make those the same float.
    relief: { slope: sa.slope, aspect: sa.aspect, synthesised },
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
    blockedAccuracy,
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
    verticalUnitToMetres: params.verticalUnitToMetres ?? null,
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
  const { crs, verticalDatum, verticalUnitToMetres, cellSizeM, dtm, gate, minZ, maxZ } = core;
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
  // The generalization tolerance actually applied (cells). Only the 'generalized'
  // style runs the Douglas–Peucker pass; for every other style it is null so the
  // provenance never claims a tolerance a style did not use. When the caller does
  // not specify one, the historical default (0.5) is what applyContourShapeStyle
  // uses, so we record that exact value.
  const generalizeToleranceCells =
    shapeStyle === 'generalized'
      ? (intervalParams.generalizeToleranceCells ?? GENERALIZE_EPS_CELLS)
      : null;
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
    generalizeToleranceCells,
    smoothing: smoothingApplied,
    despike: core.despikeApplied,
    aggregation: core.aggregation,
  };

  // 6-10) Contours → stitch → style → model → tally.
  if (intervalM == null) {
    const emptyContours: ContourSet = {
      levels: [],
      intervalM: 0,
      requestedIntervalM: 0,
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
      blockedAccuracy: core.blockedAccuracy,
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
      requestedIntervalM: null,
      contours: emptyContours,
      stitched: [],
      style: { levels: [], warnings: [] },
      model: buildFeatureModel([], [], {
        crs,
        verticalDatum,
        verticalUnitToMetres,
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
  // The interval of the levels that were actually emitted. Thinning (an
  // over-fine request against the level cap) makes this coarser than
  // `intervalM`; everything downstream — styling, the export model, provenance
  // — describes the emitted levels, so it reads this.
  // `contoursAt` is called above without an explicit `levels` list, so it
  // always resolves a single spacing here; the null case belongs to the
  // explicit-levels API, which this path does not use.
  const emittedIntervalM = contours.intervalM ?? intervalM;
  // Cell-size-aware endpoint quantum: the fixed 1 mm key is ≈111 m in a
  // degree-denominated frame and would weld a fine geographic grid's
  // contours into one blob; scaling by the cell keeps the join unit-free.
  let stitched = stitchContourSet(contours, cellSizeM);

  const style = styleLevels(
    contours.levels.map((l) => l.value),
    { intervalM: emittedIntervalM, indexEvery: intervalParams.indexEvery ?? 5 },
  );

  // Beauty: apply the chosen shape style to the raw stitched runs. Every style
  // is honesty-gated (the smoother/simplifier provably never move a low-
  // confidence vertex or bridge a gap). 'crisp' is identity; 'smooth' (default)
  // is exactly the historical Chaikin ×2, so the live contours are unchanged.
  stitched = stitched.map((level) => ({
    value: level.value,
    polylines: applyContourShapeStyle(level.polylines, shapeStyle, {
      cellSizeM,
      generalizeToleranceCells: intervalParams.generalizeToleranceCells,
      generalizeMode: intervalParams.generalizeMode,
    }),
  }));

  const model = buildFeatureModel(stitched, style.levels, {
    crs,
    verticalDatum,
    verticalUnitToMetres,
    intervalM: emittedIntervalM,
    requestedIntervalM: intervalM,
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
    blockedAccuracy: core.blockedAccuracy,
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
    intervalM: emittedIntervalM,
    requestedIntervalM: intervalM,
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
