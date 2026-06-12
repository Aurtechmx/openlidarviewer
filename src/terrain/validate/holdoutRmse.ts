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
import { horizontalCellMetres } from '../ground/horizontalScale';
import { hornSlope } from '../ground/terrainDerivatives';
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
}

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

  // Collect finite ground returns.
  const ground: TerrainPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (isGround[i] !== 1) continue;
    const p = points[i];
    if (!Number.isFinite(getH1(p)) || !Number.isFinite(getH2(p)) || !Number.isFinite(getV(p))) {
      continue;
    }
    ground.push(p);
  }

  if (ground.length < 4) {
    warnings.push('too few ground returns to cross-validate');
    return emptyReport(holdoutFraction, warnings);
  }

  // Deterministic split.
  const rng = mulberry32(params.seed ?? 1);
  const train: TerrainPoint[] = [];
  const test: TerrainPoint[] = [];
  for (const p of ground) {
    if (rng() < holdoutFraction) test.push(p);
    else train.push(p);
  }
  if (train.length === 0 || test.length === 0) {
    warnings.push('split produced an empty train or test set');
    return emptyReport(holdoutFraction, warnings);
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
  const raster = rasterizeDtm(train, new Uint8Array(train.length).fill(1), {
    grid: { originH1: minH1, originH2: minH2, cols, rows, cellSizeM },
    aggregation: params.aggregation ?? 'mean',
    verticalAxis: vertical,
  });
  const { dtm } = buildSurfaceFromRaster(raster, {
    targetCount: params.targetCount,
    isGeographic: params.isGeographic,
    horizontalUnitToMetres: params.horizontalUnitToMetres,
  });
  // Residuals are reported in metres regardless of the source vertical unit.
  const vMetres =
    Number.isFinite(params.verticalUnitToMetres) && (params.verticalUnitToMetres as number) > 0
      ? (params.verticalUnitToMetres as number)
      : 1;
  // Local slope field for slope-band stratification of the residuals; convert
  // the cell to metres for a geographic frame so the bands aren't all "steep".
  const slopeField = hornSlope(
    dtm.z,
    cols,
    rows,
    horizontalCellMetres(cellSizeM, params.isGeographic, params.horizontalUnitToMetres),
  );

  // Residuals at held-out points.
  const allAbs: number[] = [];
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
    if (samples) samples.push({ confidence: predConf, absError: abs });
  }

  if (covered === 0) {
    warnings.push('no held-out points landed in a covered cell');
    return { ...emptyReport(holdoutFraction, warnings), uncoveredCount: uncovered };
  }

  const rmse = Math.sqrt(sumSq / covered);
  const mae = sumAbs / covered;
  allAbs.sort((a, b) => a - b);
  const p95 = percentile(allAbs, 0.95);

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

  return {
    rmse,
    mae,
    p95,
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

/** Nearest-rank percentile of a pre-sorted ascending array. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(q * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function emptyReport(holdoutFraction: number, warnings: string[]): ValidationReport {
  return {
    rmse: Number.NaN,
    mae: Number.NaN,
    p95: Number.NaN,
    sampleSize: 0,
    uncoveredCount: 0,
    holdoutFraction,
    perBand: GRADE_ORDER.map((grade) => ({ grade, count: 0, rmse: Number.NaN, mae: Number.NaN })),
    method: 'holdout-cross-validation',
    coverageMode: 'full',
    warnings,
  };
}
