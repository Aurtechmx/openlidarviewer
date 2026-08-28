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
 * A third case sits above both: a source that states NO point total at all
 * ({@link StreamingSource.sourcePointCount} null). Its per-node counts are
 * decode-admission estimates, so every figure this module derives from them
 * would be fabricated. {@link UNSTATED_POINT_TOTAL} is what the grade shows
 * instead, and it carries no number.
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

/**
 * Hard ceiling on the points a single full-cloud grade may decode, independent
 * of the sampling budget. The planner always selects at least one node so a
 * positive budget never decodes nothing — but that guarantee means one
 * arbitrarily large first node (a COPC root chunk can hold hundreds of millions
 * of points) becomes the whole plan even when its count dwarfs
 * {@link SamplingPlanOptions.maxPoints}. The grade runner sizes a Float32Array
 * at `sampledPoints * 3` BEFORE decoding, so an unchecked first node forces a
 * multi-gigabyte allocation on a path that never went through the streaming
 * scheduler's device-aware first-node guard. This ceiling is that guard's
 * equivalent for the grade: above it the grade refuses rather than allocates.
 *
 * Set well above the 2,000,000-point default budget so a legitimately large
 * first node still grades, while the pathological hundreds-of-millions node is
 * declined.
 */
export const MAX_SAMPLE_POINTS = 8_000_000;

/**
 * Companion byte ceiling on the decoded POSITIONS buffer (`sampledPoints * 3`
 * Float32 values). Defends the allocation directly, so a caller that raises the
 * point budget, or a future wider position element, still cannot drive the
 * single pre-decode allocation past this size. 256 MiB.
 */
export const MAX_SAMPLE_DECODED_BYTES = 256 * 1024 * 1024;

/** Float32 positions are XYZ triples; the decode buffer is `points * 3 * 4` bytes. */
const DECODED_BYTES_PER_POINT = 3 * Float32Array.BYTES_PER_ELEMENT;

/**
 * A refusal the grade shows in place of figures. Same two slots the panel
 * renders for a graded run (a headline where the coverage label goes and a note
 * beneath), so a refusal reads as a result, not an error.
 */
export interface SampleBudgetRefusal {
  /** Stands in for the coverage label. */
  readonly headline: string;
  /** Why the grade was declined. */
  readonly note: string;
}

/**
 * Decide whether a sampling plan is too large to decode safely, returning the
 * user-facing refusal or `null` when it is within both ceilings. Pure and
 * deterministic; the runner calls it right after building the plan and BEFORE
 * sizing the decode buffer, so a plan above the ceiling never allocates.
 */
export function sampleBudgetRefusal(
  plan: Pick<SamplingPlan, 'sampledPoints'>,
): SampleBudgetRefusal | null {
  const points = Math.max(0, plan.sampledPoints);
  const decodedBytes = points * DECODED_BYTES_PER_POINT;
  if (points <= MAX_SAMPLE_POINTS && decodedBytes <= MAX_SAMPLE_DECODED_BYTES) return null;
  const mib = Math.round(decodedBytes / (1024 * 1024));
  return {
    headline: 'Full-cloud grade unavailable: the sample exceeds the safe decode budget',
    note:
      `Grading this cloud would decode ${formatPointCount(points)} points into a single ` +
      `${mib} MiB buffer, above the ${formatPointCount(MAX_SAMPLE_POINTS)}-point safe ceiling. ` +
      `The selected octree node is larger than the whole-cloud sample budget, so the grade ` +
      `declines it here rather than force a multi-gigabyte allocation the streaming loader ` +
      `itself would refuse. Grade a smaller scan or lower the sample budget.`,
  };
}

/** Whether a full-cloud grade is exact (all nodes) or estimated from a sample. */
export type GradeScope = 'exhaustive' | 'sampled';

/**
 * What the grade shows in place of figures when the source states no point
 * total. Same two slots the panel already renders for a graded run (a headline
 * where the coverage label goes, and the note beneath it), so a refusal reads
 * as a result rather than an error.
 */
export interface UnstatedPointTotal {
  /** Stands in for the coverage label. */
  readonly headline: string;
  /** Why no figure is shown. */
  readonly note: string;
}

/**
 * The refusal for a source whose `sourcePointCount` is null.
 *
 * A 3D Tiles `tileset.json` states content URIs and no point counts, so every
 * node record the reader builds carries one assumed figure that exists to
 * govern decode admission. Summing those yields (tiles x assumed), which tracks
 * how the tileset is subdivided and not how many points it holds. The streaming
 * source already refuses to add them up; the grade refuses for the same reason,
 * because a coverage label, a coverage percent and a density back-scale are all
 * built on that sum.
 *
 * Deliberately carries no number of any kind. Showing the sum with a caveat, or
 * showing zero, would each put a figure in front of a user that the file never
 * stated.
 */
export const UNSTATED_POINT_TOTAL: UnstatedPointTotal = {
  headline: 'Full-cloud grade unavailable: this format states no point total',
  note:
    "This scan's index says where its tiles are, not how many points they hold. " +
    'The per-tile counts a grade would add up are decode-admission estimates, so a ' +
    'point total, a coverage percent, or a density scaled by them would be a ' +
    'fabricated figure rather than a measurement. COPC and EPT scans state a real ' +
    'total and grade normally.',
};

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
