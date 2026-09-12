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
import { NeumaierSum } from '../../process/numerics';
import { gradeForConfidence, type EvidenceGrade } from '../ground/cellConfidence';
import { buildSurfaceFromRaster } from '../ground/surfaceFromRaster';
import type { VerticalAxis } from '../ground/groundFilter';
import { axisGetters } from '../ground/axisGetters';
import { horizontalCellMetresXY } from '../ground/horizontalScale';
import { hornSlope } from '../ground/terrainDerivatives';
import { quantileSorted } from '../quantile';
import type {
  BandError,
  ClassificationScope,
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
  /**
   * Run the blunder-only despike when rebuilding the train surface. Default
   * `true`. Set `false` to match a delivered surface built from a trusted
   * ground classification (despike disabled), so the validated surface is the
   * one the user receives rather than a despiked variant.
   */
  readonly despike?: boolean;
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
   * points, the run REFUSES: supplying this hook selects the split→classify→fit
   * estimand, and delivering the whole-cloud one under the same field names
   * would answer a question the caller did not ask. The report comes back with
   * `sampleSize 0` and an `unavailableReason`, never another estimand's number.
   */
  readonly reclassifyGround?: (
    points: ReadonlyArray<TerrainPoint>,
    isHeldOut: Uint8Array,
  ) => Uint8Array | ReadonlyArray<number>;
  /**
   * What the `reclassifyGround` hook REPRESENTS, recorded as the report's
   * {@link ClassificationScope} when it succeeds. Default `'train-only'`.
   *
   * This module cannot tell the difference from the inside: a hook that re-runs
   * a classifier over the training points and a hook that returns an all-ground
   * mask because the source's class-2 labels are authoritative both hand back a
   * mask of the right length. The trusted-survey path supplies the latter, and
   * the record said `train-only` — claiming a classifier ran when none did. The
   * caller knows which it is, so the caller states it.
   */
  readonly reclassificationKind?: Exclude<ClassificationScope, 'whole-cloud'>;
}

/**
 * Disclosure kept when the surface-fit classification leak is NOT removed
 * (no `reclassifyGround` hook): the held-out points' ground membership was
 * decided by a classifier that saw the full cloud, a mild optimism versus a
 * true classify-inside-fold. Stated, not hidden.
 */
const FULL_CLOUD_CLASSIFICATION_WARNING =
  'hold-out withholds points from the surface fit only; ground classification used the full cloud (mild optimism vs classify-inside-fold)';

/**
 * Refusal when a supplied train-only reclassifier could not produce the mask.
 * The alternative — reporting the whole-cloud figure — answers a different
 * question under the same field name, which is the substitution this module
 * exists to prevent.
 */
const TRAIN_ONLY_REFUSED =
  'train-only ground classification was requested but could not be produced; no hold-out statistic is reported (the full-cloud figure estimates a different quantity)';

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

  // Statistical parameters are REFUSED, not repaired. Substituting a working
  // default for a caller's invalid split fraction, cell size or seed produces a
  // number for a design nobody chose, and the report carries no field saying the
  // design was changed — only a warning line, which the panels do not render.
  // The blocked validator already refuses these; this is the same rule.
  const holdoutFraction = params.holdoutFraction ?? 0.2;
  if (!Number.isFinite(holdoutFraction) || holdoutFraction <= 0 || holdoutFraction >= 1) {
    const why = `holdoutFraction must be a finite fraction in (0,1); got ${holdoutFraction}`;
    warnings.push(why);
    return emptyReport(Number.NaN, warnings, why);
  }
  if (!(params.cellSizeM > 0) || !Number.isFinite(params.cellSizeM)) {
    const why = `cellSizeM must be a finite positive length; got ${params.cellSizeM}`;
    warnings.push(why);
    return emptyReport(holdoutFraction, warnings, why);
  }
  if (params.seed !== undefined && !(Number.isInteger(params.seed) && params.seed >= 0)) {
    // mulberry32 does `seed >>> 0`, which silently maps a fractional or negative
    // seed onto some other seed. Two runs recorded as different seeds could then
    // be the same split, and a recorded seed would not reproduce its own run.
    const why = `seed must be a non-negative integer; got ${params.seed}`;
    warnings.push(why);
    return emptyReport(holdoutFraction, warnings, why);
  }
  if (isGround.length !== points.length) {
    // A mask shorter than the cloud reads `undefined` past its end, which is
    // `!== 1`, so every point beyond it is silently treated as non-ground: the
    // validated sample quietly becomes a prefix of the one the caller meant.
    // `rasterizeDtm` already refuses this; the validator must not be laxer than
    // the rasterizer it feeds.
    const why =
      `ground mask length (${isGround.length}) does not match the point count (${points.length})`;
    warnings.push(why);
    return emptyReport(holdoutFraction, warnings, why);
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
    const why = 'too few ground returns to cross-validate';
    warnings.push(why);
    return emptyReport(holdoutFraction, warnings, why);
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
    const why = 'split produced an empty train or test set';
    warnings.push(why);
    return emptyReport(holdoutFraction, warnings, why);
  }

  // The DTM below is fit from `fitTrain`. The hold-out already withholds points
  // from the SURFACE FIT; the remaining leak is the ground CLASSIFICATION, which
  // decided the held-out points' membership with the full cloud in view. If the
  // caller supplied a train-only reclassifier, re-run classification WITHOUT the
  // held-out points and fit the surface from that mask — a real reduction of the
  // leak, not a reworded warning. Otherwise keep the full-cloud train set and
  // re-state the documented limitation.
  let fitTrain: TerrainPoint[] = train;
  // Set to 'train-only' ONLY where the reclassifier actually produced the mask
  // the surface was fitted from. Both failure paths below leave it at
  // 'whole-cloud', so a report can never say the requested treatment ran when
  // it did not — the warning strings alone did not stop that.
  let classificationScope: ClassificationScope = 'whole-cloud';
  if (params.reclassifyGround) {
    const isHeldOut = new Uint8Array(points.length);
    for (const idx of testIdx) isHeldOut[idx] = 1;
    let newMask: Uint8Array | ReadonlyArray<number> | null = null;
    try {
      newMask = params.reclassifyGround(points, isHeldOut);
    } catch {
      newMask = null;
    }
    if (newMask?.length !== points.length) {
      // Refuse. The caller asked for split→classify→fit; the classifier did not
      // deliver, and the whole-cloud number is a DIFFERENT estimand. Reporting
      // it here under `rmse` would substitute one for the other silently — the
      // `classificationScope` label disclosed the substitution but nothing
      // obliged a consumer to read it.
      warnings.push(TRAIN_ONLY_REFUSED, 'reclassifyGround returned an invalid mask');
      return emptyReport(holdoutFraction, warnings, TRAIN_ONLY_REFUSED);
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
        // Same refusal, other failure mode: a classifier that finds no ground in
        // the training set has not produced the requested treatment either.
        warnings.push(
          TRAIN_ONLY_REFUSED,
          'train-only reclassification produced no ground points',
        );
        return emptyReport(holdoutFraction, warnings, TRAIN_ONLY_REFUSED);
      } else {
        classificationScope = params.reclassificationKind ?? 'train-only';
        fitTrain = reTrain;
        warnings.push(
          classificationScope === 'fixed-source-classification'
            ? 'ground membership taken from the source classification, which is independent of the split, so there is no surface-fit classification leak to remove; no classifier was re-run'
            : 'ground classification re-run on training points only (held-out points excluded from the classifier); surface-fit classification leak removed',
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
  // Validated at entry — a non-positive or non-finite cell size refused there.
  const cellSizeM = params.cellSizeM;
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
    despike: params.despike,
    isGeographic: params.isGeographic,
    latitudeDeg: params.latitudeDeg,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
    verticalUnitToMetres: params.verticalUnitToMetres,
  });
  // Residuals are reported in metres WHEN the source vertical unit is known.
  // When it is not, this falls back to 1, which means the residual stays in the
  // source unit and only equals metres if the source happened to be metric.
  // Callers must not label the result 'm' on that basis — the export writers
  // hedge via verticalSuffixFromLabel. This comment previously claimed metres
  // unconditionally, which is what let a false 'm' reach the reports.
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
  // dtm.z is native vertical units; scale the rise to metres so the slope
  // bands (flat/moderate/steep) stratify residuals by true angle, not a
  // feet-over-metres ratio that would read ~3.28× too steep on foot data.
  const slopeField = hornSlope(dtm.z, cols, rows, cellM.x, cellM.y, vMetres);

  // Residuals at held-out points.
  const allAbs: number[] = [];
  // SIGNED residuals too — so we can report systematic bias (mean signed error)
  // and robust spread (NMAD), which absolute-only stats hide: a surface sitting
  // uniformly 8 cm low has a large bias but its RMSE alone looks like noise.
  const allSigned: number[] = [];
  // Compensated so the aggregate RMSE, bias and MAE stay accurate over a large
  // held-out set. The signed and absolute sums used to be naive `+=` while every
  // stratified aggregate below was compensated, so the comment there claiming
  // parity with "the headline figure" was the one thing it did not hold for.
  const sumSignedAcc = new NeumaierSum();
  const sumSqAcc = new NeumaierSum();
  const sumAbsAcc = new NeumaierSum();
  let covered = 0;
  let uncovered = 0;
  // Every residual aggregate is compensated, so a stratum's RMSE/MAE carries the
  // same accuracy as the headline figure regardless of how many points land in it.
  const bandSumSq: Record<EvidenceGrade, NeumaierSum> = {
    solid: new NeumaierSum(), dashed: new NeumaierSum(), gap: new NeumaierSum(),
  };
  const bandSumAbs: Record<EvidenceGrade, NeumaierSum> = {
    solid: new NeumaierSum(), dashed: new NeumaierSum(), gap: new NeumaierSum(),
  };
  const bandCount: Record<EvidenceGrade, number> = { solid: 0, dashed: 0, gap: 0 };
  // Stratified accumulators: by slope band and by surface zone.
  const slopeSq: Record<SlopeBand, NeumaierSum> = {
    flat: new NeumaierSum(), moderate: new NeumaierSum(), steep: new NeumaierSum(),
  };
  const slopeAbs: Record<SlopeBand, NeumaierSum> = {
    flat: new NeumaierSum(), moderate: new NeumaierSum(), steep: new NeumaierSum(),
  };
  const slopeCnt: Record<SlopeBand, number> = { flat: 0, moderate: 0, steep: 0 };
  const zoneSq: Record<SurfaceZone, NeumaierSum> = {
    measured: new NeumaierSum(), interpolated: new NeumaierSum(),
  };
  const zoneAbs: Record<SurfaceZone, NeumaierSum> = {
    measured: new NeumaierSum(), interpolated: new NeumaierSum(),
  };
  const zoneCnt: Record<SurfaceZone, number> = { measured: 0, interpolated: 0 };
  const samples: ConfidenceSample[] | null = params.collectSamples ? [] : null;

  // Grid values sit at cell CENTRES, so predict with bilinear
  // interpolation over the four surrounding centres. Weights are
  // renormalised over the covered corners, so a point near a data edge
  // still predicts from the corners that exist instead of snapping to
  // one cell. This removes grid-quantisation bias from the RMSE.
  const clampCol = (c: number): number => {
    if (c < 0) return 0;
    if (c >= cols) return cols - 1;
    return c;
  };
  const clampRow = (r: number): number => {
    if (r < 0) return 0;
    if (r >= rows) return rows - 1;
    return r;
  };
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
    sumSignedAcc.add(residual);
    sumSqAcc.add(sq);
    sumAbsAcc.add(abs);
    covered++;
    const grade = gradeForConfidence(predConf);
    bandSumSq[grade].add(sq);
    bandSumAbs[grade].add(abs);
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
    slopeSq[sb].add(sq);
    slopeAbs[sb].add(abs);
    slopeCnt[sb] += 1;
    const zone: SurfaceZone = dtm.coverage[nci] === 2 ? 'measured' : 'interpolated';
    zoneSq[zone].add(sq);
    zoneAbs[zone].add(abs);
    zoneCnt[zone] += 1;
    if (samples) samples.push({ confidence: predConf, absError: abs, zone });
  }

  if (covered === 0) {
    const why = 'no held-out points landed in a covered cell';
    warnings.push(why);
    return { ...emptyReport(holdoutFraction, warnings, why), uncoveredCount: uncovered };
  }

  const rmse = Math.sqrt(sumSqAcc.total / covered);
  const mae = sumAbsAcc.total / covered;
  allAbs.sort((a, b) => a - b);
  // Project-wide type-7 quantile (was nearest-rank — one of the three
  // conventions the v0.4.3 audit flagged; see src/terrain/quantile.ts).
  const p95 = quantileSorted(allAbs, 0.95);

  const perBand: BandError[] = GRADE_ORDER.map((grade) => {
    const n = bandCount[grade];
    return {
      grade,
      count: n,
      rmse: n > 0 ? Math.sqrt(bandSumSq[grade].total / n) : Number.NaN,
      mae: n > 0 ? bandSumAbs[grade].total / n : Number.NaN,
    };
  });

  const perSlopeBand: SlopeBandError[] = (['flat', 'moderate', 'steep'] as const).map((band) => {
    const n = slopeCnt[band];
    return {
      band,
      count: n,
      rmse: n > 0 ? Math.sqrt(slopeSq[band].total / n) : Number.NaN,
      mae: n > 0 ? slopeAbs[band].total / n : Number.NaN,
    };
  });

  const perZone: ZoneError[] = (['measured', 'interpolated'] as const).map((zone) => {
    const n = zoneCnt[zone];
    return {
      zone,
      count: n,
      rmse: n > 0 ? Math.sqrt(zoneSq[zone].total / n) : Number.NaN,
      mae: n > 0 ? zoneAbs[zone].total / n : Number.NaN,
    };
  });

  // Signed BIAS: the mean signed residual. A non-zero bias is a systematic
  // vertical offset (the surface sits high or low), which RMSE/MAE cannot show.
  const bias = sumSignedAcc.total / covered;
  // NMAD: 1.4826 × median(|residual − median(residual)|). A robust, outlier-
  // resistant spread — the ASPRS-recommended companion to RMSE for LiDAR error,
  // and the honest number to trust when residuals are non-normal.
  const nmad = normalizedMedianAbsDeviation(allSigned);

  return {
    // Random-point hold-out: nearby same-surface points remain in training, so
    // this estimates local reconstruction under dense sampling, never external
    // checkpoint accuracy. Typed so no consumer can relabel it.
    estimand: 'point-reconstruction',
    classificationScope,
    // A statistic WAS produced.
    unavailableReason: null,
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

/**
 * The refused report. `unavailableReason` is REQUIRED: while it defaulted to
 * "too few ground returns", two refusals that had nothing to do with ground
 * returns (an empty split, no held-out point on a covered cell) took the
 * default, and the panel printed that false explanation beside a warnings
 * list that said otherwise. The compiler now refuses a refusal with no reason.
 */
function emptyReport(
  holdoutFraction: number,
  warnings: string[],
  unavailableReason: string,
): ValidationReport {
  return {
    estimand: 'point-reconstruction',
    // Nothing was fitted, so no train-only classification ran.
    classificationScope: 'whole-cloud',
    unavailableReason,
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
