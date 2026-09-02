/**
 * checkpointAccuracy.ts
 *
 * Statistics over independent checkpoints: surveyed positions that were held
 * back from everything the product was built with.
 *
 * The hard rule is leakage. A checkpoint that was used as control, used in
 * registration, used to tune a parameter, or hand-corrected is no longer
 * independent, and an accuracy figure computed over it measures the fit rather
 * than the error. That is refused as a typed result, not warned about: a warning
 * ends up in a log while the number ends up in a report. The refusal names the
 * offending checkpoints so the caller can drop them deliberately and say so,
 * rather than this module silently filtering them and producing a figure whose
 * sample nobody can reconstruct. A usage string this module does not recognise
 * is refused on the same grounds: checkpoints arrive from survey CSV and JSON,
 * and a value that cannot be read cannot be shown to be independent.
 *
 * The second rule is that reference uncertainty is not silently disposed of.
 * Some standards subtract the reference survey's error from the observed error;
 * that choice belongs to whoever preregistered the study, so the combination is
 * a function the caller passes in, its identifier is echoed in the result, and
 * with no combination supplied the combined figure is `null` rather than the
 * observed RMSE relabelled.
 *
 * Output is always stratified as well as pooled. A pooled RMSE over open ground
 * and dense canopy describes neither, and the stratum that fails is the one a
 * reader needs.
 *
 * Pure arithmetic over plain arrays. No I/O, no DOM.
 */

import { NeumaierSum } from '../process/numerics';

/**
 * How a checkpoint was used. Only `independent` may enter an accuracy figure.
 *
 * The four leaking values are listed separately rather than collapsed into one
 * `leaked` flag so a refusal can say which kind of leakage happened.
 *
 * This is also the runtime whitelist: anything outside it is refused as
 * `unknown-usage` rather than defaulting to independent.
 */
export const CHECKPOINT_USAGES = [
  'independent',
  'control',
  'registration',
  'parameter-tuning',
  'manual-correction',
] as const;

export type CheckpointUsage = (typeof CHECKPOINT_USAGES)[number];

/** Usages that disqualify a checkpoint from any accuracy statistic. */
export const LEAKING_USAGES: readonly CheckpointUsage[] = [
  'control',
  'registration',
  'parameter-tuning',
  'manual-correction',
];

/**
 * What a stated reference-uncertainty number actually means.
 *
 * A survey may report a number with no statement of what it is: a standard
 * deviation, an RMSE, a 95 % positional accuracy, or a manufacturer's spec
 * bound. Only some of those are a 1-sigma standard uncertainty, and treating a
 * 95 % figure or a manufacturer bound as if it were 1-sigma understates the
 * reference error by a factor of roughly two. This module therefore refuses to
 * guess: a value whose meaning is not established is never converted to sigma.
 */
export const REFERENCE_UNCERTAINTY_MEANINGS = [
  'standard-deviation',
  'rmse',
  '95-percent',
  'manufacturer-bound',
  'unknown',
] as const;

export type ReferenceUncertaintyMeaning = (typeof REFERENCE_UNCERTAINTY_MEANINGS)[number];

/**
 * A reference-survey uncertainty with its statistical meaning made explicit.
 *
 * `source` records where the number and its meaning came from, so a report can
 * say why a value was or was not treated as a standard uncertainty.
 */
export interface ReferenceUncertainty {
  readonly valueMetres: number;
  readonly meaning: ReferenceUncertaintyMeaning;
  readonly source: string;
}

/**
 * Two-sided 95 % normal coverage factor. Dividing a 95 % positional accuracy by
 * this recovers the 1-sigma standard deviation, ASSUMING a zero-mean normal
 * error. Frozen alongside DEFAULT_CI_Z so the two cannot drift apart.
 */
export const NORMAL_95_COVERAGE_FACTOR = 1.96;

/**
 * Convert a reference uncertainty to a 1-sigma standard uncertainty, or null
 * when its meaning does not statistically justify a sigma.
 *
 * - `standard-deviation` is already sigma.
 * - `rmse` is treated as sigma under a zero-mean assumption (RMSE = sqrt(bias^2
 *   + sigma^2), so RMSE ≈ sigma when the reference is unbiased). This matches
 *   the USGS/ASPRS convention of combining RMSE terms in quadrature.
 * - `95-percent` is divided by the normal coverage factor (zero-mean normal
 *   assumption).
 * - `manufacturer-bound` and `unknown` are NOT a standard uncertainty and yield
 *   null: fabricating a sigma from them would assert a distribution nobody
 *   stated.
 */
export function referenceSigmaFromUncertainty(u: ReferenceUncertainty): number | null {
  switch (u.meaning) {
    case 'standard-deviation':
      return u.valueMetres;
    case 'rmse':
      return u.valueMetres;
    case '95-percent':
      return u.valueMetres / NORMAL_95_COVERAGE_FACTOR;
    case 'manufacturer-bound':
    case 'unknown':
      return null;
    default:
      return null;
  }
}

/**
 * Wrap a bare uncertainty number in a descriptor. The meaning defaults to
 * `unknown` (fail-closed): a legacy value with no stated meaning must NOT be
 * silently taken as 1-sigma.
 */
export function referenceUncertaintyFromValue(
  valueMetres: number,
  meaning: ReferenceUncertaintyMeaning = 'unknown',
  source = 'unspecified',
): ReferenceUncertainty {
  return { valueMetres, meaning, source };
}

export interface Checkpoint {
  readonly id: string;
  /** The product's value at the checkpoint (for example the DTM elevation). */
  readonly measured: number;
  /** The surveyed value the product is being compared against. */
  readonly reference: number;
  readonly usage: CheckpointUsage;
  /** Land cover, terrain class, or any caller-defined stratum key. */
  readonly stratum?: string;
  /**
   * 1-sigma uncertainty of `reference`, or null when the survey did not state
   * one. This field carries the 1-sigma contract: supplying it is equivalent to
   * a `referenceUncertainty` with meaning `standard-deviation`. When both are
   * supplied, `referenceUncertainty` takes precedence.
   */
  readonly referenceSigma?: number | null;
  /**
   * Reference uncertainty with its statistical meaning made explicit. Use this
   * rather than `referenceSigma` when the survey stated a 95 % figure, an RMSE,
   * a manufacturer bound, or a number of unknown meaning: only some of those may
   * be treated as a 1-sigma standard uncertainty.
   */
  readonly referenceUncertainty?: ReferenceUncertainty | null;
}

/**
 * A preregistered rule for folding reference uncertainty into the reported
 * accuracy.
 *
 * `id` is echoed into the result so a report states which rule produced the
 * number. `combine` receives the observed RMSE of the residuals and the
 * quadratic mean of the stated reference sigmas, both in the data's own units,
 * and returns the combined figure. No default is provided on purpose: adding in
 * quadrature and subtracting in quadrature give different answers and the
 * choice is the study's, not this module's.
 */
export interface UncertaintyCombination {
  readonly id: string;
  readonly combine: (observedRmse: number, referenceRmse: number) => number;
}

export interface CheckpointOptions {
  /** Refuse a sample smaller than this. */
  readonly minSample: number;
  /**
   * Multiplier on the standard error of the mean residual. Default
   * `DEFAULT_CI_Z` (95 %, two-sided, normal approximation).
   */
  readonly ciZ?: number;
  readonly uncertaintyCombination?: UncertaintyCombination;
  /** Per-stratum minimum. Defaults to `minSample`. */
  readonly minStratumSample?: number;
}

/**
 * Two-sided 95 % normal multiplier, frozen here so it cannot be chosen after
 * seeing whether an interval covered zero.
 */
export const DEFAULT_CI_Z = 1.96;

/**
 * What the interval assumes. Stated in the result because the assumption is
 * usually the weakest part of a checkpoint interval: checkpoints on the same
 * flight line or in the same stand are correlated, and this interval treats
 * them as independent. Use the block resampling in `spatialBootstrap.ts` when
 * that assumption does not hold.
 */
export const CI_ASSUMPTION = 'normal-approximation-independent-samples';

export type CheckpointRefusalReason =
  | 'leakage'
  | 'unknown-usage'
  | 'insufficient'
  | 'no-valid-residuals'
  | 'invalid-min-sample'
  | 'invalid-ci-z'
  | 'invalid-reference-sigma'
  | 'duplicate-id';

export interface CheckpointRefusal {
  readonly status: 'refused';
  readonly reason: CheckpointRefusalReason;
  readonly detail: string;
  /**
   * Checkpoint ids responsible, for `leakage`, `unknown-usage`,
   * `invalid-reference-sigma` and `duplicate-id`.
   */
  readonly offendingIds?: readonly string[];
}

/** One checkpoint's contribution, kept so a residual can be traced back. */
export interface Residual {
  readonly id: string;
  readonly stratum: string;
  /** measured − reference. Positive means the product sits high. */
  readonly residual: number;
}

export interface AccuracyStats {
  readonly n: number;
  /** Mean signed residual. Non-zero means a systematic offset. */
  readonly bias: number | null;
  readonly rmse: number | null;
  readonly medianResidual: number | null;
  readonly nmad: number | null;
  readonly p90AbsResidual: number | null;
  readonly p95AbsResidual: number | null;
  readonly maxAbsResidual: number | null;
  /** Confidence interval on the bias. null when the sample cannot support one. */
  readonly biasCiLower: number | null;
  readonly biasCiUpper: number | null;
  readonly standardError: number | null;
  /**
   * RMSE after the caller's preregistered uncertainty combination, or null when
   * no combination was supplied. Never a relabelled `rmse`.
   */
  readonly combinedRmse: number | null;
  readonly uncertaintyCombinationId: string | null;
  /**
   * Quadratic mean of the stated reference sigmas, or null unless every
   * checkpoint in the group carried a usable sigma. Reported only at full
   * coverage: a quadratic mean over a subset combined against an observed RMSE
   * over the whole group is a population mismatch, so partial and unestablished
   * coverage both leave it null.
   */
  readonly referenceRmse: number | null;
  /** Number of checkpoints in the group that carried a usable 1-sigma reference. */
  readonly referenceUncertaintyCount: number;
  /**
   * Fraction of the group that carried a usable 1-sigma reference
   * (`referenceUncertaintyCount / n`), or null when the group is empty.
   */
  readonly referenceUncertaintyCoverage: number | null;
  /**
   * Whether the reference uncertainty could be established for this group.
   *
   * - `none-stated`: no checkpoint stated a reference uncertainty. `referenceRmse`
   *   is null.
   * - `established`: every checkpoint carried a usable 1-sigma reference (full
   *   coverage), so `referenceRmse` is the quadratic mean of those sigmas and a
   *   combined RMSE can be produced.
   * - `partial`: some but not all checkpoints carried a usable sigma. A
   *   referenceRmse over that subset cannot be combined against an observed RMSE
   *   over all n without mismatching populations, so `referenceRmse` and
   *   `combinedRmse` are null and the fit RMSE stands alone.
   * - `not-established`: at least one checkpoint stated a reference uncertainty
   *   whose meaning does not justify a sigma (`unknown`/`manufacturer-bound`).
   *   `referenceRmse` and `combinedRmse` are null: the fit RMSE stands alone and
   *   is not combined against a reference uncertainty that was never established.
   */
  readonly referenceUncertaintyState: 'none-stated' | 'established' | 'partial' | 'not-established';
}

export interface StratumAccuracy {
  readonly stratum: string;
  /** `insufficient` carries counts only; every statistic is null. */
  readonly status: 'reported' | 'insufficient';
  readonly stats: AccuracyStats;
}

export interface CheckpointAccuracy {
  readonly status: 'reported';
  readonly pooled: AccuracyStats;
  readonly strata: readonly StratumAccuracy[];
  readonly residuals: readonly Residual[];
  readonly ciZ: number;
  readonly ciAssumption: typeof CI_ASSUMPTION;
  /**
   * Checkpoints dropped because `measured` or `reference` was not finite.
   *
   * Reported rather than dropped quietly: `pooled.n` alone cannot tell a reader
   * whether the sample is the whole set of checkpoints or a survivor subset, and
   * a sample nobody can reconstruct is the thing this module refuses to produce.
   */
  readonly excludedNonFiniteIds: readonly string[];
}

export type CheckpointResult = CheckpointAccuracy | CheckpointRefusal;

/** Stratum key used when a checkpoint states none. */
export const UNSTRATIFIED = 'unstratified';

function refuse(
  reason: CheckpointRefusalReason,
  detail: string,
  offendingIds?: readonly string[],
): CheckpointRefusal {
  return offendingIds ? { status: 'refused', reason, detail, offendingIds } : { status: 'refused', reason, detail };
}

/**
 * Runtime check that a `usage` is one this module understands.
 *
 * The static type cannot carry this. A checkpoint set is normally parsed from a
 * survey CSV or JSON, where `usage` is whatever string the surveyor typed, and
 * an assertion at the parse boundary makes `'Control'` a `CheckpointUsage` as
 * far as the compiler is concerned.
 */
function isUsage(v: string): v is CheckpointUsage {
  return (CHECKPOINT_USAGES as readonly string[]).includes(v);
}

/** Nearest-rank quantile, so every reported value is an observed residual. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

const EMPTY_STATS: AccuracyStats = {
  n: 0,
  bias: null,
  rmse: null,
  medianResidual: null,
  nmad: null,
  p90AbsResidual: null,
  p95AbsResidual: null,
  maxAbsResidual: null,
  biasCiLower: null,
  biasCiUpper: null,
  standardError: null,
  combinedRmse: null,
  uncertaintyCombinationId: null,
  referenceRmse: null,
  referenceUncertaintyCount: 0,
  referenceUncertaintyCoverage: null,
  referenceUncertaintyState: 'none-stated',
};

function statsOf(
  residuals: readonly number[],
  sigmas: readonly number[],
  referenceNotEstablished: boolean,
  ciZ: number,
  combination: UncertaintyCombination | undefined,
): AccuracyStats {
  const n = residuals.length;
  if (n === 0) return EMPTY_STATS;

  // Compensated accumulation: a long residual list mixing large and small
  // magnitudes loses low-order bits under naive `sum += r`.
  const sumAcc = new NeumaierSum();
  const sumSqAcc = new NeumaierSum();
  for (let i = 0; i < n; i++) {
    sumAcc.add(residuals[i]);
    sumSqAcc.add(residuals[i] * residuals[i]);
  }
  const bias = sumAcc.total / n;
  const rmse = Math.sqrt(sumSqAcc.total / n);

  const sorted = [...residuals].sort((a, b) => a - b);
  const median = quantileSorted(sorted, 0.5);
  const dev = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const nmad = 1.4826 * quantileSorted(dev, 0.5);
  const abs = residuals.map((r) => Math.abs(r)).sort((a, b) => a - b);

  // Sample standard deviation needs n > 1; with a single checkpoint there is no
  // spread to estimate, so the interval is null rather than zero-width.
  let standardError: number | null = null;
  if (n > 1) {
    const ssAcc = new NeumaierSum();
    for (let i = 0; i < n; i++) {
      const d = residuals[i] - bias;
      ssAcc.add(d * d);
    }
    standardError = Math.sqrt(ssAcc.total / (n - 1)) / Math.sqrt(n);
  }

  // Coverage of the reference uncertainty over the group. sigmaCount counts the
  // checkpoints that carried a usable 1-sigma reference; the residual population
  // is n, so partial coverage is the case where some but not all stated one.
  const sigmaCount = sigmas.length;
  const referenceUncertaintyCoverage = n > 0 ? sigmaCount / n : null;

  // The state gates in priority order. An unusable meaning
  // (unknown/manufacturer-bound) fails the whole group closed regardless of how
  // many usable sigmas the rest carried. Otherwise: no sigma is none-stated,
  // full coverage is established, and anything between is partial.
  //
  // Partial coverage is refused a combined figure on purpose. referenceRmse over
  // the covered subset combined against the observed RMSE over all n mismatches
  // populations (RMSE_reference over k vs RMSE_observed over n), so referenceRmse
  // is produced only at full coverage and combinedRmse follows it to null.
  const referenceUncertaintyState: AccuracyStats['referenceUncertaintyState'] =
    referenceNotEstablished
      ? 'not-established'
      : sigmaCount === 0
        ? 'none-stated'
        : sigmaCount < n
          ? 'partial'
          : 'established';
  const referenceRmse =
    referenceUncertaintyState === 'established'
      ? Math.sqrt(sigmas.reduce((acc, s) => acc + s * s, 0) / sigmas.length)
      : null;
  // No combination, no reference sigma, partial coverage, and an unestablished
  // reference all leave the combined figure null. Relabelling the observed RMSE
  // as "combined" would assert a propagation that never happened.
  const combinedRmse =
    combination && referenceRmse !== null ? combination.combine(rmse, referenceRmse) : null;

  return {
    n,
    bias,
    rmse,
    medianResidual: median,
    nmad,
    p90AbsResidual: quantileSorted(abs, 0.9),
    p95AbsResidual: quantileSorted(abs, 0.95),
    maxAbsResidual: abs.at(-1)!,
    biasCiLower: standardError === null ? null : bias - ciZ * standardError,
    biasCiUpper: standardError === null ? null : bias + ciZ * standardError,
    standardError,
    combinedRmse,
    uncertaintyCombinationId: combinedRmse === null ? null : combination!.id,
    referenceRmse,
    referenceUncertaintyCount: sigmaCount,
    referenceUncertaintyCoverage,
    referenceUncertaintyState,
  };
}

type ResolvedReference =
  | { readonly kind: 'none' }
  | { readonly kind: 'sigma'; readonly value: number }
  | { readonly kind: 'not-established' };

/**
 * Resolve a checkpoint's reference uncertainty to a usable 1-sigma value.
 *
 * `referenceUncertainty` (with its explicit meaning) wins when present. A bare
 * `referenceSigma` carries the 1-sigma contract and is used directly. A stated
 * uncertainty whose meaning does not justify a sigma resolves to
 * `not-established` rather than being fabricated into one.
 */
function resolveReference(c: Checkpoint): ResolvedReference {
  const u = c.referenceUncertainty;
  if (u !== undefined && u !== null) {
    const sigma = referenceSigmaFromUncertainty(u);
    return sigma === null ? { kind: 'not-established' } : { kind: 'sigma', value: sigma };
  }
  const s = c.referenceSigma;
  if (s === undefined || s === null) return { kind: 'none' };
  return { kind: 'sigma', value: s };
}

/**
 * Pooled and stratified accuracy over independent checkpoints.
 *
 * Refuses before it computes anything: leakage first, then sample size. A
 * refusal returns no partial statistics, because a partially-computed accuracy
 * figure is the thing most likely to be quoted out of context.
 */
export function checkpointAccuracy(
  checkpoints: readonly Checkpoint[],
  options: CheckpointOptions,
): CheckpointResult {
  const { minSample } = options;
  if (!Number.isInteger(minSample) || minSample < 1) {
    return refuse('invalid-min-sample', `minSample must be an integer >= 1, got ${minSample}`);
  }
  const ciZ = options.ciZ ?? DEFAULT_CI_Z;
  if (!Number.isFinite(ciZ) || ciZ <= 0) {
    return refuse('invalid-ci-z', `ciZ must be finite and > 0, got ${ciZ}`);
  }

  // Checked before leakage, because leakage cannot be decided over a usage this
  // module cannot read. Treating an unrecognised usage as independent is the
  // failure mode that matters: 'Control' with a capital C would pass the leakage
  // filter below and put registration control points into an accuracy figure.
  const unknown = checkpoints.filter((c) => !isUsage(c.usage));
  if (unknown.length > 0) {
    const detail = unknown.map((c) => `${c.id} ("${String(c.usage)}")`).join(', ');
    return refuse(
      'unknown-usage',
      `${unknown.length} checkpoint(s) state a usage that is not one of ` +
        `${CHECKPOINT_USAGES.join(', ')}: ${detail}. ` +
        'An unreadable usage cannot be shown to be independent.',
      unknown.map((c) => c.id),
    );
  }

  const leaked = checkpoints.filter((c) => LEAKING_USAGES.includes(c.usage));
  if (leaked.length > 0) {
    const detail = leaked.map((c) => `${c.id} (${c.usage})`).join(', ');
    return refuse(
      'leakage',
      `${leaked.length} checkpoint(s) are not independent: ${detail}. ` +
        'Accuracy over them measures the fit, not the error.',
      leaked.map((c) => c.id),
    );
  }

  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const c of checkpoints) {
    if (seen.has(c.id)) duplicates.push(c.id);
    seen.add(c.id);
  }
  if (duplicates.length > 0) {
    // A repeated id means the same checkpoint may be weighted twice, which
    // narrows every interval in the report.
    return refuse(
      'duplicate-id',
      `checkpoint id(s) appear more than once: ${duplicates.join(', ')}`,
      duplicates,
    );
  }

  // A stated sigma that is negative or non-finite is refused rather than used.
  // Every consumer of sigma squares it, so -0.5 and 0.5 produce the same
  // referenceRmse and the sign error disappears into a plausible number. An
  // absent sigma (null or undefined) is a different thing and stays legal: it
  // means the survey stated no uncertainty. The same rule applies to a stated
  // referenceUncertainty.valueMetres, which is a length that cannot be negative
  // regardless of its meaning.
  const badSigma = checkpoints.filter((c) => {
    const u = c.referenceUncertainty;
    if (u !== undefined && u !== null) {
      return !(Number.isFinite(u.valueMetres) && u.valueMetres >= 0);
    }
    const s = c.referenceSigma;
    return s !== undefined && s !== null && !(Number.isFinite(s) && s >= 0);
  });
  if (badSigma.length > 0) {
    return refuse(
      'invalid-reference-sigma',
      'reference uncertainty must be finite and >= 0 when stated: ' +
        badSigma
          .map((c) =>
            c.referenceUncertainty
              ? `${c.id} (${String(c.referenceUncertainty.valueMetres)})`
              : `${c.id} (${String(c.referenceSigma)})`,
          )
          .join(', '),
      badSigma.map((c) => c.id),
    );
  }

  const residuals: Residual[] = [];
  const pooled: number[] = [];
  const pooledSigmas: number[] = [];
  let pooledNotEstablished = false;
  const excludedNonFiniteIds: string[] = [];
  const byStratum = new Map<
    string,
    { residuals: number[]; sigmas: number[]; notEstablished: boolean }
  >();

  for (const c of checkpoints) {
    if (!Number.isFinite(c.measured) || !Number.isFinite(c.reference)) {
      excludedNonFiniteIds.push(c.id);
      continue;
    }
    const r = c.measured - c.reference;
    const stratum = c.stratum ?? UNSTRATIFIED;
    residuals.push({ id: c.id, stratum, residual: r });
    pooled.push(r);
    // A referenceUncertainty of unknown meaning resolves to no usable sigma; it
    // marks its group not-established rather than being silently taken as 1σ.
    const resolved = resolveReference(c);
    let bucket = byStratum.get(stratum);
    if (!bucket) {
      bucket = { residuals: [], sigmas: [], notEstablished: false };
      byStratum.set(stratum, bucket);
    }
    bucket.residuals.push(r);
    if (resolved.kind === 'sigma') {
      pooledSigmas.push(resolved.value);
      bucket.sigmas.push(resolved.value);
    } else if (resolved.kind === 'not-established') {
      pooledNotEstablished = true;
      bucket.notEstablished = true;
    }
  }

  if (pooled.length === 0) {
    return refuse(
      'no-valid-residuals',
      `none of ${checkpoints.length} checkpoint(s) carry a finite measured and reference value`,
    );
  }
  if (pooled.length < minSample) {
    return refuse(
      'insufficient',
      `${pooled.length} usable checkpoint(s), ${minSample} required`,
    );
  }

  const minStratum = options.minStratumSample ?? minSample;
  // A comparator rather than a bare sort(), and deliberately NOT localeCompare.
  // Static analysis asks for localeCompare here; it is wrong for this file.
  // localeCompare depends on the runtime locale and the ICU build, so the same
  // keys can order differently on two machines and a study record stops being
  // reproducible. Comparing by code unit is fixed by the language spec, which
  // is what a deterministic record needs. Same rule as the benchmark artifact
  // ordering.
  const strata: StratumAccuracy[] = [...byStratum.keys()]
    .sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    })
    .map((key) => {
      const bucket = byStratum.get(key)!;
      // A stratum below the floor is REPORTED as insufficient rather than
      // dropped: a reader has to see that a land-cover class exists in the
      // sample but is too thin to carry a number.
      if (bucket.residuals.length < minStratum) {
        return {
          stratum: key,
          status: 'insufficient' as const,
          stats: { ...EMPTY_STATS, n: bucket.residuals.length },
        };
      }
      return {
        stratum: key,
        status: 'reported' as const,
        stats: statsOf(
          bucket.residuals,
          bucket.sigmas,
          bucket.notEstablished,
          ciZ,
          options.uncertaintyCombination,
        ),
      };
    });

  return {
    status: 'reported',
    pooled: statsOf(pooled, pooledSigmas, pooledNotEstablished, ciZ, options.uncertaintyCombination),
    strata,
    residuals,
    ciZ,
    ciAssumption: CI_ASSUMPTION,
    excludedNonFiniteIds,
  };
}
