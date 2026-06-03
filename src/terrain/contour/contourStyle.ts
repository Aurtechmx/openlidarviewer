/**
 * contourStyle.ts
 *
 * index vs intermediate contour classification, the single
 * biggest "reads like a real topo map" lever after labels. Every Nth
 * contour (default 5th) is an INDEX contour: drawn heavier and eligible
 * for an elevation label; the rest are intermediate, drawn light and
 * unlabelled. This module also enforces that the level set is a
 * consistent interval (a topo map with mixed intervals is wrong), and
 * warns if it is not.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** Style assignment for one elevation level. */
export interface StyledLevel {
  readonly value: number;
  /** True for index (heavier, labelled) contours. */
  readonly isIndex: boolean;
  /** Relative line weight (caller maps to px). */
  readonly weight: number;
  /** Whether labels may be placed on this level. */
  readonly labelEligible: boolean;
}

/** Result of {@link styleLevels}. */
export interface ContourStyleResult {
  readonly levels: StyledLevel[];
  readonly warnings: string[];
}

/** Options for {@link styleLevels}. */
export interface ContourStyleParams {
  /** The interval the levels were generated at. Must be > 0. */
  readonly intervalM: number;
  /** Every Nth contour is an index contour. Default 5. Must be >= 1. */
  readonly indexEvery?: number;
  /** Relative weight for intermediate contours. Default 1. */
  readonly baseWeight?: number;
  /** Relative weight for index contours. Default 2. */
  readonly indexWeight?: number;
}

/**
 * Assign index/intermediate styling to a sorted level list. A level is
 * an index contour when `round(value / interval)` is a multiple of
 * `indexEvery` — anchored to elevation 0 so index lines fall on round
 * elevations (…, 0, 5, 10 m for a 1 m interval, indexEvery 5).
 */
export function styleLevels(
  values: ReadonlyArray<number>,
  params: ContourStyleParams,
): ContourStyleResult {
  const warnings: string[] = [];
  const intervalM = params.intervalM > 0 ? params.intervalM : 1;
  if (!(params.intervalM > 0)) warnings.push(`intervalM invalid; using ${intervalM}`);
  const indexEvery = Math.max(1, Math.floor(params.indexEvery ?? 5));
  const baseWeight = params.baseWeight ?? 1;
  const indexWeight = params.indexWeight ?? 2;

  // Consistency check: adjacent diffs should equal the interval.
  const sorted = [...values].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (Math.abs(d - intervalM) > intervalM * 1e-3) {
      warnings.push('level spacing is not a consistent interval');
      break;
    }
  }

  const levels: StyledLevel[] = sorted.map((value) => {
    const k = Math.round(value / intervalM);
    const aligned = Math.abs(value / intervalM - k) <= 1e-6;
    const isIndex = aligned && k % indexEvery === 0;
    return {
      value,
      isIndex,
      weight: isIndex ? indexWeight : baseWeight,
      labelEligible: isIndex,
    };
  });

  return { levels, warnings };
}
