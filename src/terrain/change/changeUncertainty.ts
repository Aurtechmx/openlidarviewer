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
 * Both σ terms are built from numbers the caller supplies, so supplying
 * neither collapses the band to ±0 — and a ±0 band clears every threshold
 * here. An empty error budget is the WEAKEST result this module can produce,
 * not the strongest, so `quantified` records that nothing was measured and
 * `detectable` / `confidence` refuse to read certainty out of it.
 *
 * The result names the error model it was computed under (`model:
 * 'independent-cells'` or `'covariance'`) so a consumer never mistakes the
 * band for a generic total uncertainty. `independent-cells` remains the
 * default. A `covariance` model is also available: it treats the random term
 * as spatially correlated (exponential semivariogram, correlation length L)
 * instead of assuming every changed cell is an independent observation — see
 * the covariance branch in {@link changeVolumeUncertainty} for the formula
 * and its documented approximation.
 *
 * Pure, deterministic. Sits beside {@link detectChange}: that computes the
 * volume, this bounds it.
 */

export type ChangeConfidence = 'high' | 'medium' | 'low';

/** The identifier of the error model a result was computed under. */
export type ChangeUncertaintyModelId = 'independent-cells' | 'covariance';

/**
 * The error model to compute the band under. Discriminated so a correlated
 * model can sit beside the default WITHOUT changing it: `independent-cells`
 * remains the default, unconditionally. `covariance` models the random term
 * as a spatially correlated field with an exponential semivariogram,
 * Cov(e_i, e_j) = σ_z²·exp(−d_ij / correlationLengthM), instead of treating
 * every changed cell as an independent observation.
 *
 * Computing the true aᵀΣa for N cells needs their pairwise distances, which
 * this module's flat, geometry-free inputs do not carry (only a cell count
 * and an area). Rather than silently downgrade to the independent model, or
 * demand a full distance matrix from every caller, the model uses a
 * documented closed-form approximation — see `changeVolumeUncertainty`'s
 * covariance branch for the derivation and its stated assumptions.
 */
export type ChangeUncertaintyModel =
  | { readonly kind: 'independent-cells' }
  | {
      readonly kind: 'covariance';
      /**
       * Correlation length (m) of the exponential semivariogram,
       * Cov(e_i, e_j) = σ_z²·exp(−d_ij / L). L → 0 recovers the
       * independent-cells band; L → ∞ recovers the fully-correlated bound
       * (every cell moves together, same as the systematic term).
       */
      readonly correlationLengthM: number;
    };

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
  /**
   * The error model to use. Defaults to `{ kind: 'independent-cells' }` — the
   * only implemented model. Provided so callers name the model explicitly and a
   * correlated model can be introduced later behind its own kind.
   */
  readonly model?: ChangeUncertaintyModel;
}

export interface ChangeVolumeUncertainty {
  /**
   * The error model the band was computed under. Always `'independent-cells'`
   * today — the caveat that the true error is larger under spatial correlation
   * travels with every result, so a reader is never handed a bare band that
   * looks like a total-uncertainty figure.
   */
  readonly model: ChangeUncertaintyModelId;
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
   * False when NO error source was supplied — `cellSigmaM` and
   * `registrationSigmaM` are both 0. The band is then ±0, which bounds nothing:
   * that is the absence of an error budget, not a perfect measurement. Read
   * this before the band; `detectable` and `confidence` already do.
   */
  readonly quantified: boolean;
  /**
   * True only when the budget is `quantified`, at least one cell changed, and
   * |net| exceeds the ~95% level of detection, 1.96σ — the same LoD convention
   * {@link cellSigmaFromLoD} documents. A |net| between 1σ and 1.96σ is NOT
   * detectable under this convention.
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
  const model = input.model ?? { kind: 'independent-cells' };
  if (model.kind !== 'independent-cells' && model.kind !== 'covariance') {
    throw new Error(
      `changeVolumeUncertainty: model '${(model as { kind: string }).kind}' is not ` +
        "implemented; available models are 'independent-cells' and 'covariance'.",
    );
  }

  const n = Math.max(0, Math.floor(input.significantCells));
  const area = Math.max(0, input.cellAreaM2);
  const cellSigma = Math.max(0, input.cellSigmaM);
  const reg = Math.max(0, input.registrationSigmaM ?? 0);

  let randomErrorM3: number;
  if (model.kind === 'covariance') {
    // Spatially correlated random term: Var(V) = aᵀΣa with a_i = area (every
    // changed cell contributes the same area) and Σ_ij = σ_z²·exp(−d_ij / L)
    // an exponential semivariogram. Building the true N×N Σ needs the pairwise
    // distances d_ij, which this module's flat inputs (a cell COUNT and an
    // area) do not carry — only geometry-aware callers could supply that, and
    // this API is deliberately geometry-free. Instead this uses a documented
    // closed-form approximation via an effective correlated-cluster size:
    //
    //   cellSizeM = √area              (assumes roughly square cells, same
    //                                    assumption `cellAreaM2`'s own doc
    //                                    comment makes)
    //   clusterCells = clamp(1 + (L / cellSizeM)², 1, N)
    //   randomErrorM3 = area · σ_z · √(N · clusterCells)
    //
    // `clusterCells` is the number of cells that move together as one
    // effectively-correlated block at length scale L. Two limits anchor it:
    //   L → 0:  clusterCells → 1 → √(N·1) = √N, i.e. the independent-cells
    //           band exactly (cells decorrelate at zero range).
    //   L → ∞:  clusterCells → N (capped) → √(N·N) = N, i.e. the fully
    //           correlated bound area·σ_z·N — every cell biased together,
    //           the same scaling as the systematic term.
    // Between the limits the exponent grows continuously and monotonically
    // with L, so σ_V rises smoothly from the independent floor to the
    // fully-correlated ceiling as the correlation length grows relative to
    // the cell size. This is an APPROXIMATION, not an exact aᵀΣa evaluation:
    // it collapses the true correlation structure (which depends on the
    // actual footprint shape of the changed cells) into a single scalar
    // cluster size driven by L vs. cell size. It is stated here, not hidden,
    // and travels in `caveats` below.
    const cellSizeM = Math.sqrt(area);
    const l = Math.max(0, model.correlationLengthM);
    const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
    const clusterCells =
      cellSizeM > 0 ? clamp(1 + (l / cellSizeM) ** 2, 1, Math.max(1, n)) : 1;
    randomErrorM3 = area * cellSigma * Math.sqrt(n * clusterCells);
  } else {
    randomErrorM3 = area * cellSigma * Math.sqrt(n);
  }
  const systematicErrorM3 = n * area * reg;
  const sigmaM3 = Math.hypot(randomErrorM3, systematicErrorM3);

  const net = input.netVolumeM3;
  const absNet = Math.abs(net);
  const relativeError = absNet > 0 ? sigmaM3 / absNet : 0;
  // An error budget with NO source in it. Both σ terms are built from inputs
  // the caller supplies, so with neither supplied the band collapses to ±0 —
  // and a ±0 band passes every threshold below, which used to grade an
  // entirely unmeasured change "detectable, 0% relative, high confidence".
  // That reads as the most certain result the module can produce when it is
  // in fact the least supported one, so nothing was measured is now stated
  // rather than rendered as certainty. Reachable through the public surface:
  // `levelOfDetectionM: 0` is explicitly permitted (both the change core and
  // `compareDtms` clamp with Math.max(0, …)), and `cellSigmaFromLoD(0)` is 0.
  const quantified = cellSigma > 0 || reg > 0;
  // Detection threshold: the module's documented LoD convention is ~95%,
  // i.e. 1.96σ (see cellSigmaFromLoD). Comparing against bare σ would call
  // a ~68%-significant wiggle "detectable". `n >= 1` closes the same
  // fail-open from the other side: with no changed cells σ is 0 whatever the
  // budget says, so any net at all would clear a zero threshold.
  const detectable = quantified && n >= 1 && absNet > 1.96 * sigmaM3;

  let confidence: ChangeConfidence;
  if (!detectable || n < 1) confidence = 'low';
  else if (relativeError <= 0.1) confidence = 'high';
  else if (relativeError <= 0.3) confidence = 'medium';
  else confidence = 'low';

  const caveats: string[] = [];
  if (!quantified) {
    caveats.push(
      'No error source is quantified — per-cell σ and co-registration RMSE are both 0, ' +
        'so the ±0 m³ band bounds nothing and the change is reported as not detectable ' +
        'rather than as certain. Supply a level of detection (and a registration RMSE) ' +
        'to bound it.',
    );
  } else if (!detectable) {
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
  if (model.kind === 'covariance') {
    caveats.push(
      `Random cell noise uses a spatially correlated (covariance) model with correlation ` +
        `length ${model.correlationLengthM} m; the effective cluster size is an approximation ` +
        `from correlation length vs. cell size, not an exact pairwise-distance covariance.`,
    );
  } else {
    caveats.push(
      'Random cell noise is assumed spatially independent; the true error is larger if it is correlated.',
    );
  }

  return {
    model: model.kind,
    sigmaM3,
    lowM3: net - sigmaM3,
    highM3: net + sigmaM3,
    relativeError,
    randomErrorM3,
    systematicErrorM3,
    confidence,
    quantified,
    detectable,
    caveats,
  };
}
