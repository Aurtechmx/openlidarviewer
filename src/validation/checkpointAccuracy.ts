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
 * sample nobody can reconstruct.
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

/**
 * How a checkpoint was used. Only `independent` may enter an accuracy figure.
 *
 * The four leaking values are listed separately rather than collapsed into one
 * `leaked` flag so a refusal can say which kind of leakage happened.
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

export interface Checkpoint {
  readonly id: string;
  /** The product's value at the checkpoint (for example the DTM elevation). */
  readonly measured: number;
  /** The surveyed value the product is being compared against. */
  readonly reference: number;
  readonly usage: CheckpointUsage;
  /** Land cover, terrain class, or any caller-defined stratum key. */
  readonly stratum?: string;
  /** 1-sigma uncertainty of `reference`, or null when the survey did not state one. */
  readonly referenceSigma?: number | null;
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
  | 'insufficient'
  | 'no-valid-residuals'
  | 'invalid-min-sample'
  | 'invalid-ci-z'
  | 'duplicate-id';

export interface CheckpointRefusal {
  readonly status: 'refused';
  readonly reason: CheckpointRefusalReason;
  readonly detail: string;
  /** Checkpoint ids responsible, for `leakage` and `duplicate-id`. */
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
  /** Quadratic mean of the stated reference sigmas, or null when none were stated. */
  readonly referenceRmse: number | null;
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
};

function statsOf(
  residuals: readonly number[],
  sigmas: readonly number[],
  ciZ: number,
  combination: UncertaintyCombination | undefined,
): AccuracyStats {
  const n = residuals.length;
  if (n === 0) return EMPTY_STATS;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += residuals[i];
    sumSq += residuals[i] * residuals[i];
  }
  const bias = sum / n;
  const rmse = Math.sqrt(sumSq / n);

  const sorted = [...residuals].sort((a, b) => a - b);
  const median = quantileSorted(sorted, 0.5);
  const dev = residuals.map((r) => Math.abs(r - median)).sort((a, b) => a - b);
  const nmad = 1.4826 * quantileSorted(dev, 0.5);
  const abs = residuals.map((r) => Math.abs(r)).sort((a, b) => a - b);

  // Sample standard deviation needs n > 1; with a single checkpoint there is no
  // spread to estimate, so the interval is null rather than zero-width.
  let standardError: number | null = null;
  if (n > 1) {
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = residuals[i] - bias;
      ss += d * d;
    }
    standardError = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
  }

  const referenceRmse =
    sigmas.length === 0
      ? null
      : Math.sqrt(sigmas.reduce((acc, s) => acc + s * s, 0) / sigmas.length);
  // No combination and no reference sigma both leave the combined figure null.
  // Relabelling the observed RMSE as "combined" would assert a propagation that
  // never happened.
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
    maxAbsResidual: abs[abs.length - 1],
    biasCiLower: standardError === null ? null : bias - ciZ * standardError,
    biasCiUpper: standardError === null ? null : bias + ciZ * standardError,
    standardError,
    combinedRmse,
    uncertaintyCombinationId: combinedRmse === null ? null : combination!.id,
    referenceRmse,
  };
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

  const residuals: Residual[] = [];
  const pooled: number[] = [];
  const pooledSigmas: number[] = [];
  const byStratum = new Map<string, { residuals: number[]; sigmas: number[] }>();

  for (const c of checkpoints) {
    if (!Number.isFinite(c.measured) || !Number.isFinite(c.reference)) continue;
    const r = c.measured - c.reference;
    const stratum = c.stratum ?? UNSTRATIFIED;
    residuals.push({ id: c.id, stratum, residual: r });
    pooled.push(r);
    const sigma = c.referenceSigma;
    if (sigma !== undefined && sigma !== null && Number.isFinite(sigma)) {
      pooledSigmas.push(sigma);
    }
    let bucket = byStratum.get(stratum);
    if (!bucket) {
      bucket = { residuals: [], sigmas: [] };
      byStratum.set(stratum, bucket);
    }
    bucket.residuals.push(r);
    if (sigma !== undefined && sigma !== null && Number.isFinite(sigma)) bucket.sigmas.push(sigma);
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
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
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
        stats: statsOf(bucket.residuals, bucket.sigmas, ciZ, options.uncertaintyCombination),
      };
    });

  return {
    status: 'reported',
    pooled: statsOf(pooled, pooledSigmas, ciZ, options.uncertaintyCombination),
    strata,
    residuals,
    ciZ,
    ciAssumption: CI_ASSUMPTION,
  };
}
