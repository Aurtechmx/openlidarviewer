/**
 * fullCloudGrade.ts
 *
 * The honesty layer for the full-cloud grade (the B-trigger). {@link
 * buildSamplingPlan} decides which octree nodes to decode; this module turns the
 * resulting {@link SamplingPlan} into the two things a grade computed from that
 * sample needs to stay honest:
 *
 *   1. `samplePointScale` — the factor that back-scales per-area densities from
 *      the decoded SAMPLE up to the whole cloud, exactly as the preview path
 *      scales a strided gather (a 7%-coverage sample reads ~14× too sparse
 *      unless its density is multiplied back up). Always ≥ 1 and finite.
 *
 *   2. A `scope` + human `label` + `note` that state whether the grade is EXACT
 *      (every node decoded) or ESTIMATED from a representative sample, with the
 *      coverage fraction — so a full-cloud grade never implies a completeness it
 *      doesn't have.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { SamplingPlan } from './samplingPlan';
import { formatPointCount } from '../../io/loadPlan';

/** Whether a full-cloud grade is exact (all nodes) or estimated from a sample. */
export type GradeScope = 'exhaustive' | 'sampled';

/** The honesty + scaling facts derived from a {@link SamplingPlan}. */
export interface FullCloudGradeCoverage {
  /** 'exhaustive' only when EVERY node was decoded; else 'sampled'. */
  readonly scope: GradeScope;
  /** Points actually decoded for the grade. */
  readonly sampledPoints: number;
  /** Points in the whole cloud. */
  readonly totalPoints: number;
  /** Rounded coverage percent (0..100) for display. */
  readonly coveragePercent: number;
  /**
   * Density back-scale = totalPoints / sampledPoints, floored at 1 and always
   * finite (1 when exhaustive or when the sample is degenerate). Feed this to
   * the terrain runner's `samplePointScale` so graded densities reflect the
   * whole cloud, not the sample.
   */
  readonly samplePointScale: number;
  /**
   * Human label, e.g. `"all 1.8M points (exact)"` or
   * `"1.8M of 18.2M points (10%, sampled)"`.
   */
  readonly label: string;
  /** Honesty caveat to surface alongside a sampled grade; '' when exhaustive. */
  readonly note: string;
}

const SAMPLED_NOTE =
  'Graded from a representative octree sample — density and coverage are estimated for the whole cloud, not measured exhaustively.';

/** Format the coverage percent, collapsing a tiny-but-nonzero fraction to "<1%". */
function percentLabel(fraction: number, rounded: number): string {
  if (fraction > 0 && rounded < 1) return '<1%';
  return `${rounded}%`;
}

/**
 * Derive the honest coverage + density-scale facts for a full-cloud grade from
 * its sampling plan. Defensive against an empty/degenerate plan (returns a
 * scale of 1 and a "no points" label rather than a NaN/Infinity).
 */
export function fullCloudGradeCoverage(plan: SamplingPlan): FullCloudGradeCoverage {
  const sampledPoints = Math.max(0, plan.sampledPoints);
  const totalPoints = Math.max(0, plan.totalPoints);
  const fraction = totalPoints > 0 ? Math.min(1, sampledPoints / totalPoints) : 0;
  const coveragePercent = Math.round(fraction * 100);
  const scope: GradeScope = plan.exhaustive ? 'exhaustive' : 'sampled';

  // Back-scale density from sample → whole cloud. Floored at 1 and guarded
  // against a zero/degenerate sample so a grade can never read 0/NaN/Infinity.
  const samplePointScale =
    scope === 'exhaustive' || sampledPoints <= 0 || !Number.isFinite(totalPoints)
      ? 1
      : Math.max(1, totalPoints / sampledPoints);

  let label: string;
  let note: string;
  if (totalPoints <= 0) {
    label = 'no points available to grade';
    note = SAMPLED_NOTE;
  } else if (scope === 'exhaustive') {
    label = `all ${formatPointCount(totalPoints)} points (exact)`;
    note = '';
  } else {
    label = `${formatPointCount(sampledPoints)} of ${formatPointCount(totalPoints)} points (${percentLabel(fraction, coveragePercent)}, sampled)`;
    note = SAMPLED_NOTE;
  }

  return { scope, sampledPoints, totalPoints, coveragePercent, samplePointScale, label, note };
}
