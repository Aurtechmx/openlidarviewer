/**
 * terrainQualityScore.ts
 *
 * A single calibrated 0–100 terrain quality score that summarises how much a
 * surveyor should trust the DTM, combining six honest signals:
 *
 *   coverage    — measured cells as a fraction of covered cells
 *   confidence  — mean per-cell confidence
 *   validation  — hold-out vertical RMSE (lower is better)
 *   density     — mean ground returns per cell vs a half-saturation floor
 *   edge        — fraction of measured cells NOT on the survey boundary
 *   ground      — ground returns as a fraction of all returns
 *
 * It complements — does not replace — the ready/previewOnly/blocked gate: the
 * gate decides whether export is allowed; the score says how good the surface
 * is within that. Unknown signals (no validation, unknown ground ratio) score
 * a neutral 0.5 rather than being assumed good, so the score never overclaims.
 *
 * Pure data — no DOM. Deterministic.
 */

/** Inputs to the composite score — all pre-computed by the pipeline. */
export interface TerrainQualityInput {
  /** Measured cells / covered cells, 0..1. */
  readonly measuredOfCovered: number;
  /** Mean per-cell confidence, 0..100. */
  readonly meanCellConfidence: number;
  /** Hold-out vertical RMSE in metres, or null when unvalidated. */
  readonly holdoutRmseM: number | null;
  /** Ground returns / all returns, 0..1, or null when unknown. */
  readonly groundPointRatio: number | null;
  /** Fraction of measured cells on the survey boundary, 0..1. */
  readonly edgeRiskRatio: number;
  /** Mean ground returns per square metre. */
  readonly meanDensity: number;
  /** DTM cell size (metres) — converts density to returns/cell. */
  readonly cellSizeM: number;
}

/** Each component's 0..1 sub-score + its weight, for a transparent breakdown. */
export interface QualityComponent {
  readonly label: string;
  readonly score: number; // 0..1
  readonly weight: number; // 0..1
  /** True when the input was unknown and a neutral 0.5 was used. */
  readonly neutral: boolean;
}

export type QualityBand = 'excellent' | 'good' | 'fair' | 'poor';

export interface TerrainQualityScore {
  /** 0..100 composite. */
  readonly score: number;
  readonly band: QualityBand;
  readonly components: ReadonlyArray<QualityComponent>;
}

/** Vertical RMSE (m) at which the validation sub-score is 0.5. */
const RMSE_HALF_M = 0.15;
/** Returns-per-cell at which the density sub-score is 0.5. */
const DENSITY_HALF_COUNT = 3;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function bandFor(score: number): QualityBand {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'poor';
}

/** Compute the composite terrain quality score. */
export function terrainQualityScore(input: TerrainQualityInput): TerrainQualityScore {
  const returnsPerCell = Math.max(0, input.meanDensity) * Math.max(1e-9, input.cellSizeM) ** 2;

  const validationKnown = input.holdoutRmseM != null && Number.isFinite(input.holdoutRmseM);
  const groundKnown = input.groundPointRatio != null && Number.isFinite(input.groundPointRatio);

  const components: QualityComponent[] = [
    {
      label: 'Coverage',
      weight: 0.25,
      neutral: false,
      score: clamp01(input.measuredOfCovered),
    },
    {
      label: 'Confidence',
      weight: 0.25,
      neutral: false,
      score: clamp01(input.meanCellConfidence / 100),
    },
    {
      label: 'Validation',
      weight: 0.2,
      neutral: !validationKnown,
      // RMSE → 0..1: 0 m ⇒ 1, RMSE_HALF ⇒ 0.5. Neutral 0.5 when unvalidated.
      score: validationKnown
        ? RMSE_HALF_M / (RMSE_HALF_M + Math.max(0, input.holdoutRmseM as number))
        : 0.5,
    },
    {
      label: 'Density',
      weight: 0.15,
      neutral: false,
      score: returnsPerCell / (returnsPerCell + DENSITY_HALF_COUNT),
    },
    {
      label: 'Edge support',
      weight: 0.1,
      neutral: false,
      score: clamp01(1 - input.edgeRiskRatio),
    },
    {
      label: 'Ground returns',
      weight: 0.05,
      neutral: !groundKnown,
      score: groundKnown ? clamp01(input.groundPointRatio as number) : 0.5,
    },
  ];

  let acc = 0;
  for (const c of components) acc += c.weight * c.score;
  const score = Math.round(100 * clamp01(acc));

  return { score, band: bandFor(score), components };
}
