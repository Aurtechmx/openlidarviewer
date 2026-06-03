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
import { holdoutValidateDtm } from '../validate/holdoutRmse';
import { checkCalibration } from '../validate/calibrationCheck';
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
  /** Vertical datum. */
  readonly verticalDatum?: string | null;
  /** Explicit contour interval; when omitted, the gate's recommendation is used. */
  readonly intervalM?: number;
  /** Every Nth contour is an index contour. Default 5. */
  readonly indexEvery?: number;
  /** Vertical axis of the source frame. Default 'z'. */
  readonly verticalAxis?: VerticalAxis;
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

  // 1) Ground classification.
  const gf = classifyGroundSmrf(points, {
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
  const raster = rasterizeDtm(points, gf.isGround, {
    grid: {
      originH1: gf.originH1,
      originH2: gf.originH2,
      cols: gf.cols,
      rows: gf.rows,
      cellSizeM: params.cellSizeM,
    },
    verticalAxis,
  });
  const dtm = buildDtmGrid(raster, { crs, verticalDatum });
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
  const validation = holdoutValidateDtm(points, gf.isGround, {
    cellSizeM: params.cellSizeM,
    seed: params.holdoutSeed ?? 1,
    verticalAxis,
  });
  const calibration = checkCalibration(validation);
  const accuracy = computeVerticalAccuracy(validation);

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
      gate,
      intervalM: null,
      contours: emptyContours,
      stitched: [],
      style: { levels: [], warnings: [] },
      model: buildFeatureModel([], [], { crs, verticalDatum, intervalM: 0 }),
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

  const model = buildFeatureModel(stitched, style.levels, { crs, verticalDatum, intervalM });
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
