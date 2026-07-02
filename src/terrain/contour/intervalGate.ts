/**
 * intervalGate.ts
 *
 * Honesty gate for contour interval selection. Offering a 0.5 m
 * interval on a surface whose vertical error is 1 m is a lie generator:
 * it draws dense, authoritative-looking contours out of interpolation
 * noise. This module decides which candidate intervals a given DTM can
 * honestly support and recommends a sensible default — so the UI can
 * disable unsupported intervals with a stated reason rather than
 * silently drawing fiction.
 *
 * The key input is the validation RMSE: you cannot resolve
 * contours much finer than roughly twice the surface's measured vertical
 * error. This is where the validation harness pays off — it turns an
 * abstract "confidence" into a concrete cartographic constraint.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** One candidate interval and whether it is honestly supported. */
export interface IntervalOption {
  readonly intervalM: number;
  readonly supported: boolean;
  /** Empty when supported; otherwise why it is disabled. */
  readonly reason: string;
}

/** Result of {@link gateIntervals}. */
export interface IntervalGateResult {
  readonly options: IntervalOption[];
  /** Recommended default interval, or null when nothing is supportable. */
  readonly recommendedM: number | null;
  readonly warnings: string[];
}

/** Inputs to {@link gateIntervals}. */
export interface IntervalGateParams {
  /** DTM cell size, source linear units. */
  readonly cellSizeM: number;
  /** Total elevation span of the surface (maxZ - minZ). */
  readonly elevationRangeM: number;
  /**
   * Measured vertical RMSE from the validation harness, or null/omitted
   * when no validation has run (then only the elevation-range rule
   * applies and a warning notes the missing constraint).
   */
  readonly rmseM?: number | null;
  /** Candidate intervals. Default [0.5, 1, 2, 5, 10]. */
  readonly candidates?: ReadonlyArray<number>;
  /**
   * Multiple of RMSE below which an interval is unsupported. Default 2
   * (≈ Nyquist on the vertical error floor).
   */
  readonly rmseMultiple?: number;
  /**
   * Absolute elevation bounds of the surface (source units). When BOTH are
   * finite the coarse-interval rule uses the EXACT level-crossing test —
   * an interval is supported iff a multiple of it falls inside [minZ, maxZ]
   * (`ceil(minZ/i)·i ≤ maxZ`). Without them the gate falls back to the
   * range-only heuristic `i < range`, which FALSELY rejects e.g.
   * minZ 0.4 / maxZ 1.2 at interval 1 (range 0.8 < 1, yet the level 1.0
   * exists) — the audit's `intervalGate` finding.
   */
  readonly minZ?: number | null;
  readonly maxZ?: number | null;
}

const DEFAULT_CANDIDATES = [0.5, 1, 2, 5, 10] as const;

/**
 * Decide which contour intervals are honestly supported and recommend a
 * default. An interval is unsupported when it is finer than
 * `rmseMultiple × RMSE` (would draw noise) or when it is so coarse it
 * yields no contours over the elevation range.
 */
export function gateIntervals(params: IntervalGateParams): IntervalGateResult {
  const warnings: string[] = [];
  const candidates = (params.candidates ?? DEFAULT_CANDIDATES).filter(
    (c) => Number.isFinite(c) && c > 0,
  );
  const range = Number.isFinite(params.elevationRangeM) ? params.elevationRangeM : 0;
  const rmseMultiple = params.rmseMultiple ?? 2;

  const hasRmse = params.rmseM != null && Number.isFinite(params.rmseM) && params.rmseM >= 0;
  const minByError = hasRmse ? rmseMultiple * (params.rmseM as number) : 0;
  // Exact crossing test available only when the caller passed real bounds.
  const hasBounds =
    params.minZ != null &&
    params.maxZ != null &&
    Number.isFinite(params.minZ) &&
    Number.isFinite(params.maxZ) &&
    (params.maxZ as number) >= (params.minZ as number);
  // True when NO contour level (multiple of `intervalM`) falls inside the
  // surface's elevation span. The first candidate level at or above minZ is
  // `ceil(minZ/i)·i`; if even that exceeds maxZ, the interval yields nothing.
  const yieldsNoContours = (intervalM: number): boolean =>
    hasBounds
      ? Math.ceil((params.minZ as number) / intervalM) * intervalM > (params.maxZ as number)
      : intervalM >= range;
  if (!hasRmse) {
    warnings.push('no validation RMSE provided — interval support judged on elevation range only');
  }
  if (range <= 0) {
    warnings.push('elevation range is zero — no contours possible');
  }

  const options: IntervalOption[] = candidates
    .slice()
    .sort((a, b) => a - b)
    .map((intervalM) => {
      if (range <= 0) {
        return { intervalM, supported: false, reason: 'flat surface — no elevation range' };
      }
      if (hasRmse && intervalM < minByError) {
        return {
          intervalM,
          supported: false,
          reason: `finer than ${rmseMultiple}× surface error (RMSE ${(params.rmseM as number).toFixed(2)})`,
        };
      }
      if (yieldsNoContours(intervalM)) {
        return {
          intervalM,
          supported: false,
          reason: 'coarser than the elevation range — yields no contours',
        };
      }
      return { intervalM, supported: true, reason: '' };
    });

  // Recommend: the smallest supported interval whose contour count is in
  // a legible band (4..40); fall back to the coarsest supported.
  const supported = options.filter((o) => o.supported).map((o) => o.intervalM);
  let recommendedM: number | null = null;
  for (const intervalM of supported) {
    const count = range / intervalM;
    if (count >= 4 && count <= 40) {
      recommendedM = intervalM;
      break;
    }
  }
  if (recommendedM == null && supported.length > 0) {
    recommendedM = supported[supported.length - 1];
  }

  return { options, recommendedM, warnings };
}
