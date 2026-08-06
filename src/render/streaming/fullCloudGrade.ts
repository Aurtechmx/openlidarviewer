/**
 * fullCloudGrade.ts
 *
 * The honesty layer for the full-cloud grade. {@link
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
 *      (every node decoded from a WHOLE hierarchy) or ESTIMATED, with the
 *      coverage fraction — so a full-cloud grade never implies a completeness it
 *      doesn't have.
 *
 * "Exact" needs TWO independent facts, because the sampling plan can only ever
 * see the nodes the octree actually LOADED. `plan.exhaustive` means "the sample
 * covered every loaded node"; it says nothing about a hierarchy that stopped
 * short at its page ceiling, swallowed a page-fetch failure, or skipped a
 * malformed entry — all of which leave subtrees out of the store while the walk
 * still reports "finished". So the caller threads the octree's own completeness
 * ({@link OctreeCompleteness}) in, and a grade is labelled exact ONLY when the
 * sample was exhaustive AND the hierarchy was whole. A truncated cloud is graded
 * over the part that loaded and SAID SO — never labelled "exact" over a subset.
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

/**
 * The source octree's completeness, threaded into the coverage decision. The
 * {@link SamplingPlan} is derived from the LOADED nodes only, so it cannot tell
 * a whole hierarchy from one that stopped short — this carries that fact from
 * the octree (`StreamingOctree` / `EptOctree`) to the honesty layer. A grade may
 * be labelled "exact" ONLY when `complete` is true.
 */
export interface OctreeCompleteness {
  /** false when the hierarchy dropped a node — a page/file ceiling, a fetch failure, or a malformed entry. */
  readonly complete: boolean;
  /** How many hierarchy load errors were recorded — surfaced so the count isn't write-only. */
  readonly errorCount: number;
}

/** The default when no completeness is supplied: a pure-plan caller grading a whole tree. */
const COMPLETE: OctreeCompleteness = { complete: true, errorCount: 0 };

const SAMPLED_NOTE =
  'Graded from a representative octree sample — density and coverage are estimated for the whole cloud, not measured exhaustively.';

/**
 * The caveat for a grade over an INCOMPLETE hierarchy — some of the file never
 * loaded, so the figures cover only the part that did. Distinct from
 * {@link SAMPLED_NOTE}: sampling is a deliberate budget choice over a whole
 * cloud; this is a shortfall in the cloud itself, and it names the recorded
 * error count so the otherwise write-only `octree.errors` reaches the user.
 */
function incompleteNote(sampledPoints: number, errorCount: number): string {
  const base =
    `This scan's point hierarchy did not fully load, so the grade covers only the ` +
    `${formatPointCount(sampledPoints)} points that were read — a partial figure, not the whole file.`;
  if (errorCount <= 0) return base;
  const noun = errorCount === 1 ? 'load error was' : 'load errors were';
  return `${base} ${errorCount} ${noun} recorded.`;
}

/** Format the coverage percent, collapsing a tiny-but-nonzero fraction to "<1%". */
function percentLabel(fraction: number, rounded: number): string {
  if (fraction > 0 && rounded < 1) return '<1%';
  return `${rounded}%`;
}

/**
 * Derive the honest coverage + density-scale facts for a full-cloud grade from
 * its sampling plan and the source octree's {@link OctreeCompleteness}.
 * Defensive against an empty/degenerate plan (returns a scale of 1 and a "no
 * points" label rather than a NaN/Infinity).
 *
 * `completeness` defaults to complete, so a pure-plan caller that is grading a
 * whole tree (and the existing tests) keeps the plain exhaustive/sampled
 * behaviour; the live grade passes the real octree state.
 */
export function fullCloudGradeCoverage(
  plan: SamplingPlan,
  completeness: OctreeCompleteness = COMPLETE,
): FullCloudGradeCoverage {
  const sampledPoints = Math.max(0, plan.sampledPoints);
  const totalPoints = Math.max(0, plan.totalPoints);
  const fraction = totalPoints > 0 ? Math.min(1, sampledPoints / totalPoints) : 0;
  const coveragePercent = Math.round(fraction * 100);

  // EXACT demands two independent facts: the sample covered every node the
  // octree HOLDS (`plan.exhaustive`), and the octree HOLDS every node the file
  // has (`completeness.complete`). The planner only ever sees loaded nodes, so
  // `plan.exhaustive` on its own means "sampled everything we loaded" — it is
  // blind to a hierarchy that stopped at the page ceiling, swallowed a fetch
  // failure, or skipped a malformed entry. Labelling that "exact" is the silent
  // under-report this guards against; a partial hierarchy is 'sampled', never
  // exhaustive.
  const scope: GradeScope = plan.exhaustive && completeness.complete ? 'exhaustive' : 'sampled';

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
  } else if (!completeness.complete) {
    // Incomplete hierarchy: report only what loaded and say why. The
    // percentage-of-total wording is deliberately withheld — the denominator we
    // have (loaded-node sum) is not the file's true count, so a "% of total"
    // here would itself be a quiet fabrication.
    label = `${formatPointCount(sampledPoints)} points graded (partial)`;
    note = incompleteNote(sampledPoints, completeness.errorCount);
  } else {
    label = `${formatPointCount(sampledPoints)} of ${formatPointCount(totalPoints)} points (${percentLabel(fraction, coveragePercent)}, sampled)`;
    note = SAMPLED_NOTE;
  }

  return { scope, sampledPoints, totalPoints, coveragePercent, samplePointScale, label, note };
}
