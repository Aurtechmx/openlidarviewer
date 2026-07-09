/**
 * reliabilitySplit.ts
 *
 * Keeps two different quantities from being reported as if they were the same
 * thing (research-hardening Phase 4, and the visual split EVIDENCE_UI.md asks
 * for). A DTM cell is either:
 *
 *   - MEASURED — it contains real ground returns. Here we can state an
 *     *empirical reliability*: of the held-out points that landed on measured
 *     cells, what fraction came within a tolerance τ? That is a testable
 *     probability, and it gets a proper confidence interval.
 *
 *   - INTERPOLATED — it was filled across a gap. There is no held-out truth in
 *     a void, so any "confidence" there is *model-based support*, not a
 *     measured probability. Reporting it with the same kind of number invites
 *     over-trust. We report its coverage and label it, and we do NOT attach an
 *     empirical reliability to it.
 *
 * The measured-cell interval is the Wilson score interval, which behaves at
 * small counts where the normal approximation (p ± 1.96·√(p(1−p)/n)) gives
 * bounds outside [0,1] or a zero-width interval at p = 0 or 1.
 *
 * Pure data, deterministic. No DOM, no I/O.
 */

/** z for a two-sided 95% interval. */
const Z_95 = 1.959963984540054;

export interface EmpiricalReliability {
  /** Held-out points scored on measured cells. */
  readonly n: number;
  /** Points within tolerance τ. */
  readonly within: number;
  /** Empirical reliability, `within / n`. NaN when `n` is 0. */
  readonly reliability: number;
  /** Tolerance the reliability is stated against, in the residual unit. */
  readonly tolerance: number;
  /** Wilson lower bound, clamped to [0,1]. NaN when `n` is 0. */
  readonly ciLow: number;
  /** Wilson upper bound, clamped to [0,1]. NaN when `n` is 0. */
  readonly ciHigh: number;
  /** The interval's confidence level (0.95). */
  readonly ciLevel: number;
}

export interface InterpolatedSupport {
  /** Held-out points that landed on interpolated cells. */
  readonly n: number;
  /**
   * Coverage-based support only: the share of the interpolated held-out points
   * within tolerance, offered as a rough indicator, NOT a calibrated
   * probability. Consumers must not present this as a reliability.
   */
  readonly withinFraction: number;
  /** Always false — an interpolated figure is never a calibrated reliability. */
  readonly calibrated: false;
  /** Fixed caption so the distinction is carried into every surface. */
  readonly note: string;
}

export interface ReliabilitySplit {
  readonly measured: EmpiricalReliability;
  readonly interpolated: InterpolatedSupport;
}

/** One held-out residual, tagged by the zone of the cell it landed in. */
export interface ZonedSample {
  readonly absError: number;
  readonly zone: 'measured' | 'interpolated';
}

/**
 * Wilson score interval for a binomial proportion `k/n` at 95%. Returns bounds
 * inside [0,1] even at k = 0 or k = n, where the normal approximation fails.
 */
export function wilsonInterval(k: number, n: number): { low: number; high: number } {
  if (n <= 0) return { low: Number.NaN, high: Number.NaN };
  const z = Z_95;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}

/**
 * Empirical reliability of a set of absolute residuals at tolerance `tol`: the
 * fraction within τ, with a Wilson 95% interval. This is the measured-cell
 * figure; feed it only residuals from measured cells.
 */
export function empiricalReliability(
  absErrors: readonly number[],
  tol: number,
): EmpiricalReliability {
  const finite = absErrors.filter((e) => Number.isFinite(e));
  const n = finite.length;
  let within = 0;
  for (const e of finite) if (e <= tol) within++;
  if (n === 0) {
    return {
      n: 0, within: 0, reliability: Number.NaN, tolerance: tol,
      ciLow: Number.NaN, ciHigh: Number.NaN, ciLevel: 0.95,
    };
  }
  const { low, high } = wilsonInterval(within, n);
  return {
    n, within, reliability: within / n, tolerance: tol,
    ciLow: low, ciHigh: high, ciLevel: 0.95,
  };
}

/**
 * Split held-out samples by zone and report each honestly: measured cells get
 * an empirical reliability with a CI; interpolated cells get labelled
 * model-based support with no reliability claim.
 */
export function splitReliability(
  samples: readonly ZonedSample[],
  tol: number,
): ReliabilitySplit {
  const measuredErrors: number[] = [];
  const interpErrors: number[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.absError)) continue;
    (s.zone === 'measured' ? measuredErrors : interpErrors).push(s.absError);
  }
  let interpWithin = 0;
  for (const e of interpErrors) if (e <= tol) interpWithin++;
  return {
    measured: empiricalReliability(measuredErrors, tol),
    interpolated: {
      n: interpErrors.length,
      withinFraction: interpErrors.length > 0 ? interpWithin / interpErrors.length : Number.NaN,
      calibrated: false,
      note: 'Model-based support over interpolated cells — not a calibrated reliability.',
    },
  };
}
