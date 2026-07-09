/**
 * holdoutRmse.ts
 *
 * hold-out cross-validation of the DTM surface. The
 * key reliability principle is that a confidence band you never test
 * is unfalsifiable. This module tests it: it withholds a deterministic
 * fraction of the ground returns, rebuilds the DTM from the rest, then
 * measures the vertical residual at each withheld point against the
 * rebuilt surface. The residuals are aggregated overall and bucketed by
 * the evidence grade of the cell each point landed in, so a downstream
 * `calibrationCheck` can assert that high-confidence cells really do
 * predict better.
 *
 * It validates the SURFACE MODEL, not the classifier: it consumes an
 * already-classified ground mask and asks "given these ground returns,
 * how well does the gridded DTM predict a held-out ground return?".
 *
 * Determinism: selection uses a seeded mulberry32 PRNG, so the same
 * points + seed always produce the same split and the same report.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { TerrainPoint } from '../TerrainContracts';
import { rasterizeDtm, type DtmAggregation } from '../ground/rasterizeDtm';
import { gradeForConfidence, type EvidenceGrade } from '../ground/cellConfidence';
import { buildSurfaceFromRaster } from '../ground/surfaceFromRaster';
import type { VerticalAxis } from '../ground/groundFilter';
import { axisGetters } from '../ground/axisGetters';
import { horizontalCellMetresXY } from '../ground/horizontalScale';
import { hornSlope } from '../ground/terrainDerivatives';
import { quantileSorted } from '../quantile';
import type {
  BandError,
  ConfidenceSample,
  SlopeBand,
  SlopeBandError,
  SurfaceZone,
  ValidationReport,
  ZoneError,
} from './ValidationReport';

// Slope-band thresholds as rise/run (tan): flat < 5°, moderate < 20°, else steep.
const SLOPE_FLAT = Math.tan((5 * Math.PI) / 180);
const SLOPE_MODERATE = Math.tan((20 * Math.PI) / 180);
function slopeBandFor(slope: number): SlopeBand {
  if (!Number.isFinite(slope) || slope < SLOPE_FLAT) return 'flat';
  if (slope < SLOPE_MODERATE) return 'moderate';
  return 'steep';
}

/** Options for {@link holdoutValidateDtm}. */
export interface HoldoutParams {
  /** Fraction of ground returns to withhold, 0..1. Default 0.2. */
  readonly holdoutFraction?: number;
  /** PRNG seed for reproducible splits. Default 1. */
  readonly seed?: number;
  /** DTM cell size, source linear units. Must be > 0. */
  readonly cellSizeM: number;
  /** Per-cell aggregation for the DTM. Default `mean`. */
  readonly aggregation?: DtmAggregation;
  /** Vertical axis of the source frame. Default `'z'`. */
  readonly verticalAxis?: VerticalAxis;
  /** Density (returns/cell) earning full confidence; default = scene median. */
  readonly targetCount?: number;
  /**
   * Collect the raw (predicted confidence, abs error) pair for every
   * covered held-out point, returned as `report.samples`. Off by default;
   * the confidence calibration turns it on.
   */
  readonly collectSamples?: boolean;
  /** True when the horizontal frame is geographic (degrees). Default false. */
  readonly isGeographic?: boolean;
  /**
   * WORLD grid-centre latitude (degrees) for the geographic cos φ E–W scale,
   * so the slope-band stratification uses the SAME slope definition as the
   * live derivative stage. The points fed here are render-recentred (local
   * Y ≈ 0), so only the caller can supply the real latitude. Null / omitted
   * falls back to the local-bbox estimate (correct only for un-recentred
   * data).
   */
  readonly latitudeDeg?: number | null;
  /**
   * Metres per source vertical unit (1 for metre data, ~0.3048 for feet). The
   * residuals are scaled by this so the reported RMSE/MAE/p95 are in metres
   * regardless of the source Z unit. Default 1.
   */
  readonly verticalUnitToMetres?: number;
  /**
   * Metres per source horizontal unit (~0.3048 for feet) for a projected frame,
   * so the slope's run is in metres. Ignored when `isGeographic`. Default 1.
   */
  readonly horizontalUnitToMetres?: number;
  /**
   * OPTIONAL train-only ground reclassifier — the honest fix for the
   * classify-before-split leak. This module validates a SURFACE given a ground
   * mask; it does not itself own a classifier, so by default the mask it is
   * handed was produced over the WHOLE cloud (the held-out points helped decide
   * their own ground membership — a mild optimism).
   *
   * When supplied, this hook is invoked ONCE with the full point array and a
   * `isHeldOut` flag array (1 ⇒ that point is a held-out test point that MUST be
   * excluded from classification). It must return a fresh ground mask over
   * `points`. The surface is then fit from the points this train-only pass calls
   * ground (minus the held-out set), so the held-out points no longer influence
   * the classification that decides the training surface — the leak is removed
   * for the fold's fit rather than merely disclosed.
   *
   * Must be pure and deterministic (same inputs → same mask) to keep the report
   * reproducible. If it throws, returns a wrong-length mask, or yields no ground
   * points, the run falls back to the supplied full-cloud mask and re-states the
   * documented limitation in `warnings`.
   */
  readonly reclassifyGround?: (
    points: ReadonlyArray<TerrainPoint>,
    isHeldOut: Uint8Array,
  ) => Uint8Array | ReadonlyArray<number>;
}

/**
 * Disclosure kept when the surface-fit classification leak is NOT removed
 * (no `reclassifyGround` hook): the held-out points' ground membership was
 * decided by a classifier that saw the full cloud, a mild optimism versus a
 * true classify-inside-fold. Stated, not hidden.
 */
const FULL_CLOUD_CLASSIFICATION_WARNING =
  'hold-out withholds points from the surface fit only; ground classification used the full cloud (mild optimism vs classify-inside-fold)';

/** Small, fast, deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRADE_ORDER: ReadonlyArray<EvidenceGrade> = ['solid', 'dashed', 'gap'];

/**
 * Run a hold-out cross-validation pass and return a {@link ValidationReport}.
 *
 * Honest on degenerate inputs: too few ground returns to split → a
 * report with `sampleSize 0` and a warning, never a thrown error.
 */
export function holdoutValidateDtm(
  points: ReadonlyArray<TerrainPoint>,
  isGround: Uint8Array | ReadonlyArray<number>,
  params: HoldoutParams,
): ValidationReport {
  const warnings: string[] = [];
  const vertical: VerticalAxis = params.verticalAxis ?? 'z';
  const { getH1, getH2, getV } = axisGetters(vertical);

  let holdoutFraction = params.holdoutFraction ?? 0.2;
  if (!Number.isFinite(holdoutFraction) || holdoutFraction <= 0 || holdoutFraction >= 1) {
    warnings.push(`holdoutFraction invalid (${holdoutFraction}); using 0.2`);
    holdoutFraction = 0.2;
  }

  // Collect finite ground returns, keeping each one's index back into the
  // source `points` array so a train-only reclassifier can be told exactly which
  // originals were withheld.
  const ground: TerrainPoint[] = [];
  const groundIdx: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (isGround[i] !== 1) continue;
    const p = points[i];
    if (!Number.isFinite(getH1(p)) || !Number.isFinite(getH2(p)) || !Number.isFinite(getV(p))) {
      continue;
    }
    ground.push(p);
    groundIdx.push(i);
  }

  if (ground.length < 4) {
    warnings.push('too few ground returns to cross-validate');
    return emptyReport(holdoutFraction, warnings);
  }

  // Deterministic split. Iterate by index (identical RNG draw order to the
  // previous `for..of ground`, so the split is unchanged) while recording each
  // held-out point's ORIGINAL source index for the reclassifier.
  const rng = mulberry32(params.seed ?? 1);
  const train: TerrainPoint[] = [];
  const test: TerrainPoint[] = [];
  const testIdx: number[] = [];
  for (let j = 0; j < ground.length; j++) {
    const p = ground[j];
    if (rng() < holdoutFraction) {
      test.push(p);
      testIdx.push(groundIdx[j]);
    } else {
      train.push(p);
    }
  }
  if (train.length === 0 || test.length === 0) {
    warnings.push('split produced an empty train or test set');
    return emptyReport(holdoutFraction, warnings);
  }

  // The DTM below is fit from `fitTrain`. The hold-out already withholds points
  // from the SURFACE FIT; the remaining leak is the ground CLASSIFICATION, which
  // decided the held-out points' membership with the full cloud in view. If the
  // caller supplied a train-only reclassifier, re-run classification WITHOUT the
  // held-out points and fit the surface from that mask — a real reduction of the
  // leak, not a reworded warning. Otherwise keep the full-cloud train set and
  // re-state the documented limitation.
  let fitTrain: TerrainPoint[] = train;
  if (params.reclassifyGround) {
    const isHeldOut = new Uint8Array(points.length);
    for (const idx of testIdx) isHeldOut[idx] = 1;
    let newMask: Uint8Array | ReadonlyArray<number> | null = null;
    try {
      newMask = params.reclassifyGround(points, isHeldOut);
    } catch {
      newMask = null;
    }
    if (!newMask || newMask.length !== points.length) {
      warnings.push(
        'reclassifyGround returned an invalid mask; falling back to full-cloud classification',
      );
      warnings.push(FULL_CLOUD_CLASSIFICATION_WARNING);
    } else {
      const reTrain: TerrainPoint[] = [];
      for (let i = 0; i < points.length; i++) {
        if (isHeldOut[i] === 1) continue; // held-out points never train the surface
        if (newMask[i] !== 1) continue;
        const p = points[i];
        if (!Number.isFinite(getH1(p)) || !Number.isFinite(getH2(p)) || !Number.isFinite(getV(p))) {
          continue;
        }
        reTrain.push(p);
      }
      if (reTrain.length === 0) {
        warnings.push(
          'train-only reclassification produced no ground points; falling back to full-cloud classification',
        );
        warnings.push(FULL_CLOUD_CLASSIFICATION_WARNING);
      } else {
        fitTrain = reTrain;
        warnings.push(
          'ground classification re-run on training points only (held-out points excluded from the classifier); surface-fit classification leak removed',
        );
      }
    }
  } else {
    warnings.push(FULL_CLOUD_CLASSIFICATION_WARNING);
  }

  // Grid covering ALL ground returns so test points map into it.
  let minH1 = Infinity;
  let minH2 = Infinity;
  let maxH1 = -Infinity;
  let maxH2 = -Infinity;
  for (const p of ground) {
    const h1 = getH1(p);
    const h2 = getH2(p);
    if (h1 < minH1) minH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 > maxH2) maxH2 = h2;
  }
  const cellSizeM = params.cellSizeM > 0 ? params.cellSizeM : 1;
  if (!(params.cellSizeM > 0)) warnings.push(`cellSizeM invalid; using ${cellSizeM}`);
  const cols = Math.max(1, Math.floor((maxH1 - minH1) / cellSizeM) + 1);
  const rows = Math.max(1, Math.floor((maxH2 - minH2) / cellSizeM) + 1);

  // Build the DTM from TRAIN only — through the SAME shared raster→grid
  // constructor the live pipeline uses (despike + extrapolation guard + unit
  // params included), so the validated surface is constructed exactly like
  // the delivered one. Before v0.4.5 this path skipped the despike and the
  // extrapolation guard and dropped `horizontalUnitToMetres`, so the
  // confidence calibration was fit against a DIFFERENT surface.
  const raster = rasterizeDtm(fitTrain, new Uint8Array(fitTrain.length).fill(1), {
    grid: { originH1: minH1, originH2: minH2, cols, rows, cellSizeM },
    aggregation: params.aggregation ?? 'mean',
    verticalAxis: vertical,
  });
  const { dtm } = buildSurfaceFromRaster(raster, {
    targetCount: params.targetCount,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
  });
  // Residuals are reported in metres regardless of the source vertical unit.
  const vMetres =
    Number.isFinite(params.verticalUnitToMetres) && (params.verticalUnitToMetres as number) > 0
      ? (params.verticalUnitToMetres as number)
      : 1;
  // Local slope field for slope-band stratification of the residuals; convert
  // the cell to metres per axis for a geographic frame (longitude shrinks by
  // cos(latitude)) so the bands aren't all "steep" and aren't E–W biased.
  const cellM = horizontalCellMetresXY(
    cellSizeM,
    params.isGeographic,
    // Prefer the caller's WORLD latitude: the held-out points are render-
    // recentred (local Y ≈ 0 → cos φ silently 1). The local-bbox fallback
    // stays correct for data in absolute coordinates.
    params.latitudeDeg ?? minH2 + (rows / 2) * cellSizeM,
    params.horizontalUnitToMetres,
  );
  const slopeField = hornSlope(dtm.z, cols, rows, cellM.x, cellM.y);

  // Residuals at held-out points.
  const allAbs: number[] = [];
  // SIGNED residuals too — so we can report systematic bias (mean signed error)
  // and robust spread (NMAD), which absolute-only stats hide: a surface sitting
  // uniformly 8 cm low has a large bias but its RMSE alone looks like noise.
  const allSigned: number[] = [];
  let sumSigned = 0;
  let sumSq = 0;
  let sumAbs = 0;
  let covered = 0;
  let uncovered = 0;
  const bandSumSq: Record<EvidenceGrade, number> = { solid: 0, dashed: 0, gap: 0 };
  const bandSumAbs: Record<EvidenceGrade, number> = { solid: 0, dashed: 0, gap: 0 };
  const bandCount: Record<EvidenceGrade, number> = { solid: 0, dashed: 0, gap: 0 };
  // Stratified accumulators: by slope band and by surface zone.
  const slopeSq: Record<SlopeBand, number> = { flat: 0, moderate: 0, steep: 0 };
  const slopeAbs: Record<SlopeBand, number> = { flat: 0, moderate: 0, steep: 0 };
  const slopeCnt: Record<SlopeBand, number> = { flat: 0, moderate: 0, steep: 0 };
  const zoneSq: Record<SurfaceZone, number> = { measured: 0, interpolated: 0 };
  const zoneAbs: Record<SurfaceZone, number> = { measured: 0, interpolated: 0 };
  const zoneCnt: Record<SurfaceZone, number> = { measured: 0, interpolated: 0 };
  const samples: ConfidenceSample[] | null = params.collectSamples ? [] : null;

  // Grid values sit at cell CENTRES, so predict with bilinear
  // interpolation over the four surrounding centres. Weights are
  // renormalised over the covered corners, so a point near a data edge
  // still predicts from the corners that exist instead of snapping to
  // one cell. This removes grid-quantisation bias from the RMSE.
  const clampCol = (c: number) => (c < 0 ? 0 : c >= cols ? cols - 1 : c);
  const clampRow = (r: number) => (r < 0 ? 0 : r >= rows ? rows - 1 : r);
  for (const p of test) {
    const fx = (getH1(p) - minH1) / cellSizeM - 0.5;
    const fy = (getH2(p) - minH2) / cellSizeM - 0.5;
    const col0 = Math.floor(fx);
    const row0 = Math.floor(fy);
    const tx = fx - col0;
    const ty = fy - row0;
    const corners: Array<[number, number, number]> = [
      [clampCol(col0), clampRow(row0), (1 - tx) * (1 - ty)],
      [clampCol(col0 + 1), clampRow(row0), tx * (1 - ty)],
      [clampCol(col0), clampRow(row0 + 1), (1 - tx) * ty],
      [clampCol(col0 + 1), clampRow(row0 + 1), tx * ty],
    ];
    let sumW = 0;
    let sumZ = 0;
    let sumC = 0;
    for (const [cc, cr, w] of corners) {
      const ci = cr * cols + cc;
      if (w <= 0 || dtm.coverage[ci] === 0 || !Number.isFinite(dtm.z[ci])) continue;
      sumW += w;
      sumZ += w * dtm.z[ci];
      sumC += w * dtm.confidence[ci];
    }
    if (sumW <= 0) {
      uncovered++;
      continue;
    }
    const predZ = sumZ / sumW;
    const predConf = sumC / sumW;
    const residual = (getV(p) - predZ) * vMetres;
    const abs = Math.abs(residual);
    const sq = residual * residual;
    allAbs.push(abs);
    allSigned.push(residual);
    sumSigned += residual;
    sumSq += sq;
    sumAbs += abs;
    covered++;
    const grade = gradeForConfidence(predConf);
    bandSumSq[grade] += sq;
    bandSumAbs[grade] += abs;
    bandCount[grade] += 1;
    // Stratify by the CONTAINING cell's slope band and surface zone — floor
    // binning, the same convention the raster was built with. `Math.round`
    // here attributed points in the right/upper half of each cell to the
    // NEXT cell over (audit finding: half-cell misattribution in the
    // per-slope/zone RMSE tables).
    const ncol = clampCol(Math.floor((getH1(p) - minH1) / cellSizeM));
    const nrow = clampRow(Math.floor((getH2(p) - minH2) / cellSizeM));
    const nci = nrow * cols + ncol;
    const sb = slopeBandFor(slopeField[nci]);
    slopeSq[sb] += sq;
    slopeAbs[sb] += abs;
    slopeCnt[sb] += 1;
    const zone: SurfaceZone = dtm.coverage[nci] === 2 ? 'measured' : 'interpolated';
    zoneSq[zone] += sq;
    zoneAbs[zone] += abs;
    zoneCnt[zone] += 1;
    if (samples) samples.push({ confidence: predConf, absError: abs, zone });
  }

  if (covered === 0) {
    warnings.push('no held-out points landed in a covered cell');
    return { ...emptyReport(holdoutFraction, warnings), uncoveredCount: uncovered };
  }

  const rmse = Math.sqrt(sumSq / covered);
  const mae = sumAbs / covered;
  allAbs.sort((a, b) => a - b);
  // Project-wide type-7 quantile (was nearest-rank — one of the three
  // conventions the v0.4.3 audit flagged; see src/terrain/quantile.ts).
  const p95 = quantileSorted(allAbs, 0.95);

  const perBand: BandError[] = GRADE_ORDER.map((grade) => {
    const n = bandCount[grade];
    return {
      grade,
      count: n,
      rmse: n > 0 ? Math.sqrt(bandSumSq[grade] / n) : Number.NaN,
      mae: n > 0 ? bandSumAbs[grade] / n : Number.NaN,
    };
  });

  const perSlopeBand: SlopeBandError[] = (['flat', 'moderate', 'steep'] as const).map((band) => {
    const n = slopeCnt[band];
    return {
      band,
      count: n,
      rmse: n > 0 ? Math.sqrt(slopeSq[band] / n) : Number.NaN,
      mae: n > 0 ? slopeAbs[band] / n : Number.NaN,
    };
  });

  const perZone: ZoneError[] = (['measured', 'interpolated'] as const).map((zone) => {
    const n = zoneCnt[zone];
    return {
      zone,
      count: n,
      rmse: n > 0 ? Math.sqrt(zoneSq[zone] / n) : Number.NaN,
      mae: n > 0 ? zoneAbs[zone] / n : Number.NaN,
    };
  });

  // Signed BIAS: the mean signed residual. A non-zero bias is a systematic
  // vertical offset (the surface sits high or low), which RMSE/MAE cannot show.
  const bias = sumSigned / covered;
  // NMAD: 1.4826 × median(|residual − median(residual)|). A robust, outlier-
  // resistant spread — the ASPRS-recommended companion to RMSE for LiDAR error,
  // and the honest number to trust when residuals are non-normal.
  const nmad = normalizedMedianAbsDeviation(allSigned);

  return {
    rmse,
    mae,
    p95,
    bias,
    nmad,
    sampleSize: covered,
    uncoveredCount: uncovered,
    holdoutFraction,
    perBand,
    perSlopeBand,
    perZone,
    method: 'holdout-cross-validation',
    coverageMode: raster.coverage,
    ...(samples ? { samples } : {}),
    warnings: [...warnings, ...dtm.warnings],
  };
}

/**
 * Normalised median absolute deviation: 1.4826 × median(|x − median(x)|). The
 * constant makes NMAD a consistent estimator of the standard deviation for
 * normally-distributed data, while staying robust to the outliers (blunders,
 * vegetation hits) that inflate RMSE. Returns NaN for an empty sample.
 */
function normalizedMedianAbsDeviation(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const med = quantileSorted(sorted, 0.5);
  const dev = values.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return 1.4826 * quantileSorted(dev, 0.5);
}

function emptyReport(holdoutFraction: number, warnings: string[]): ValidationReport {
  return {
    rmse: Number.NaN,
    mae: Number.NaN,
    p95: Number.NaN,
    bias: Number.NaN,
    nmad: Number.NaN,
    sampleSize: 0,
    uncoveredCount: 0,
    holdoutFraction,
    perBand: GRADE_ORDER.map((grade) => ({ grade, count: 0, rmse: Number.NaN, mae: Number.NaN })),
    method: 'holdout-cross-validation',
    coverageMode: 'full',
    warnings,
  };
}
