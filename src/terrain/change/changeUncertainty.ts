/**
 * changeUncertainty.ts
 *
 * The ± band on a two-epoch volume change — the number cloud viewers print bare
 * ("this pile shrank 1,240 m³") that survey-grade work must qualify ("± 90,
 * detectable") to be honest.
 *
 * The error model is the standard geomorphic DEM-of-difference one:
 *
 *   - RANDOM cell noise — each changed cell's elevation difference carries a
 *     vertical 1σ (`cellSigmaM`). Treating cells as spatially independent, their
 *     volume errors add in quadrature, so the random component scales with the
 *     square root of the changed-cell count: cellArea·σ·√N. More cells average
 *     it down.
 *   - SYSTEMATIC co-registration — a vertical mis-alignment between the two
 *     epochs biases EVERY cell the same direction, so it does NOT average away;
 *     it scales with the full changed area: (N·cellArea)·σ_reg. This is the term
 *     that quietly dominates a real survey, and the one most tools omit.
 *
 * The two independent sources combine in quadrature. The result also states
 * whether the net change clears the ~95% level of detection — this module's
 * own documented LoD convention (LoD ≈ 1.96σ, see {@link cellSigmaFromLoD}).
 * A change below that threshold is indistinguishable from noise and must be
 * reported as such, never as a confident gain or loss. (v0.5.4: the flag
 * previously compared |net| against 1σ — a ~68% bar — while the module
 * converted LoDs at 1.96σ; the two conventions now agree.)
 *
 * Pure, deterministic. Sits beside {@link detectChange}: that computes the
 * volume, this bounds it.
 */

export type ChangeConfidence = 'high' | 'medium' | 'low';

export interface ChangeVolumeUncertaintyInput {
  /** The net volume (m³) whose band we want — usually `stats.netVolumeM3`. */
  readonly netVolumeM3: number;
  /** Significant (changed) cell count — `stats.gained + stats.lost`. */
  readonly significantCells: number;
  /** Cell area in m² — `(cellSizeM · horizontalUnitToMetres)²`. */
  readonly cellAreaM2: number;
  /**
   * Per-cell vertical 1σ of the elevation DIFFERENCE (random, uncorrelated).
   * If you only know the Level of Detection, use {@link cellSigmaFromLoD}.
   */
  readonly cellSigmaM: number;
  /**
   * Systematic vertical bias 1σ between the two epochs (co-registration RMSE),
   * correlated across all cells. Defaults to 0 — and when it is 0 the result
   * says so loudly, because an unquantified registration error is the most
   * common way a change number lies.
   */
  readonly registrationSigmaM?: number;
}

export interface ChangeVolumeUncertainty {
  readonly sigmaM3: number;
  /** net ∓ σ. Signed — a net loss stays negative, never clamped to 0. */
  readonly lowM3: number;
  readonly highM3: number;
  /** σ / |net|, or 0 when net is 0. */
  readonly relativeError: number;
  readonly randomErrorM3: number;
  readonly systematicErrorM3: number;
  readonly confidence: ChangeConfidence;
  /**
   * True only when |net| exceeds the ~95% level of detection, 1.96σ — the
   * same LoD convention {@link cellSigmaFromLoD} documents. A |net| between
   * 1σ and 1.96σ is NOT detectable under this convention.
   */
  readonly detectable: boolean;
  readonly caveats: readonly string[];
}

/**
 * Convert a Level of Detection into a per-cell 1σ. A LoD is conventionally the
 * ~95% detection threshold ≈ 1.96σ, so σ ≈ LoD / 1.96.
 */
export function cellSigmaFromLoD(lodM: number): number {
  return lodM > 0 ? lodM / 1.96 : 0;
}

export function changeVolumeUncertainty(
  input: ChangeVolumeUncertaintyInput,
): ChangeVolumeUncertainty {
  const n = Math.max(0, Math.floor(input.significantCells));
  const area = Math.max(0, input.cellAreaM2);
  const cellSigma = Math.max(0, input.cellSigmaM);
  const reg = Math.max(0, input.registrationSigmaM ?? 0);

  const randomErrorM3 = area * cellSigma * Math.sqrt(n);
  const systematicErrorM3 = n * area * reg;
  const sigmaM3 = Math.hypot(randomErrorM3, systematicErrorM3);

  const net = input.netVolumeM3;
  const absNet = Math.abs(net);
  const relativeError = absNet > 0 ? sigmaM3 / absNet : 0;
  // Detection threshold: the module's documented LoD convention is ~95%,
  // i.e. 1.96σ (see cellSigmaFromLoD). Comparing against bare σ would call
  // a ~68%-significant wiggle "detectable".
  const detectable = absNet > 1.96 * sigmaM3;

  let confidence: ChangeConfidence;
  if (!detectable || n < 1) confidence = 'low';
  else if (relativeError <= 0.1) confidence = 'high';
  else if (relativeError <= 0.3) confidence = 'medium';
  else confidence = 'low';

  const caveats: string[] = [];
  if (!detectable) {
    caveats.push(
      `Net change (${Math.round(net)} m³) is below the ~95% level of detection ` +
        `(1.96σ ≈ ${Math.round(1.96 * sigmaM3)} m³) — not distinguishable from ` +
        `survey noise.`,
    );
  }
  if (reg === 0) {
    caveats.push(
      'Co-registration error is not included — the band reflects random survey noise only. ' +
        'Supply a registration RMSE to bound the systematic component.',
    );
  }
  caveats.push(
    'Random cell noise is assumed spatially independent; the true error is larger if it is correlated.',
  );

  return {
    sigmaM3,
    lowM3: net - sigmaM3,
    highM3: net + sigmaM3,
    relativeError,
    randomErrorM3,
    systematicErrorM3,
    confidence,
    detectable,
    caveats,
  };
}
