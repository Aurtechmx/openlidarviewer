/**
 * fullCloudGradeRunner.ts
 *
 * The orchestration seam for the full-cloud grade. It joins
 * the two tested cores — {@link buildSamplingPlan} (which octree nodes to
 * decode) and {@link fullCloudGradeCoverage} (the honesty + density back-scale)
 * — to a caller-supplied decode and grade step, and assembles the decoded
 * sample in deterministic plan order.
 *
 * The decode (`decodeNode`) and the grade (`grade`) are injected, NOT imported:
 *   • decode is live streaming I/O (range read + worker decompress) that needs a
 *     browser + a real COPC/EPT to exercise — so it stays a dependency the live
 *     wiring provides and a mock satisfies in tests;
 *   • grade is the terrain pipeline (`analyseContours`), kept at arm's length so
 *     this module carries no terrain/three.js weight and stays pure-testable.
 *
 * This is the "tested core ahead of the interactive surface" the project favours:
 * the orchestration logic (plan → coverage → ordered assembly → back-scaled
 * grade) is deterministic and unit-tested here; only the injected decode is
 * browser-bound.
 */

import { buildSamplingPlan, type SampleNode, type SamplingPlanOptions } from './samplingPlan';
import {
  fullCloudGradeCoverage,
  sampleBudgetRefusal,
  type FullCloudGradeCoverage,
  type OctreeCompleteness,
  type SampleBudgetRefusal,
} from './fullCloudGrade';

/**
 * Thrown when a sampling plan exceeds the decode budget ceilings, BEFORE the
 * runner sizes its positions buffer. Carries the user-facing {@link
 * SampleBudgetRefusal} so the adapter can turn it into an 'unavailable' outcome
 * (headline + note) rather than a red error. Distinct from an abort: the runner
 * already throws for a cancelled signal, and this is the second refusal the same
 * seam recognises.
 */
export class FullCloudGradeRefusedError extends Error {
  readonly refusal: SampleBudgetRefusal;
  constructor(refusal: SampleBudgetRefusal) {
    super(refusal.headline);
    this.name = 'FullCloudGradeRefusedError';
    this.refusal = refusal;
  }
}

/**
 * Thrown when a decoded node's point count does not equal the count its header
 * declared. COPC/EPT/OOC hierarchy counts are exact, so a mismatch means the
 * sample is not what the plan measured — the coverage percent and the density
 * back-scale were computed from the PLAN, and silently grading a short (or
 * over-long) sample under a plan-based scale would report a coverage the grade
 * never decoded. The grade fails cleanly instead of reweighting.
 */
export class FullCloudGradeShortDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FullCloudGradeShortDecodeError';
  }
}

/** Decode one node's points into local-space XYZ triples. Live = range read + worker. */
export type DecodeNodeFn = (nodeId: string, signal?: AbortSignal) => Promise<Float32Array>;

/** Grade an assembled sample; `samplePointScale` back-scales sample density → whole cloud. */
export type GradeFn<G> = (positions: Float32Array, samplePointScale: number) => G;

/**
 * Running progress of a full-cloud grade, emitted after each node decodes — for
 * a "decoding N of M nodes" readout. Shared by {@link runFullCloudGrade} and the
 * adapter's `gradeFullCloud` so the two can't drift.
 */
export interface GradeProgress {
  /** Nodes decoded and assembled so far. */
  readonly decodedNodes: number;
  /** Total nodes the plan will decode. */
  readonly totalNodes: number;
  /** XYZ points (triples) assembled so far. */
  readonly decodedPoints: number;
}

export interface FullCloudGradeRun<G> {
  /** The honesty + scaling facts (scope, coverage %, label, note). */
  readonly coverage: FullCloudGradeCoverage;
  /** The caller's grade over the assembled sample. */
  readonly grade: G;
}

/**
 * Plan, decode, and grade the full cloud from its octree node records.
 *
 * Deterministic given a deterministic `decodeNode`: nodes are decoded in the
 * plan's shallow→deep order and concatenated in that order, then graded once
 * with the plan's density back-scale. Honest by construction — the returned
 * {@link FullCloudGradeCoverage} states whether the grade is exhaustive or
 * sampled and at what coverage, so a sampled grade never implies completeness.
 *
 * @throws if `signal` is aborted before or during decoding (cooperative cancel).
 */
export async function runFullCloudGrade<G>(args: {
  readonly nodes: readonly SampleNode[];
  readonly decodeNode: DecodeNodeFn;
  readonly grade: GradeFn<G>;
  readonly options?: SamplingPlanOptions;
  readonly signal?: AbortSignal;
  /**
   * Called after each node decodes, with the running {@link GradeProgress} —
   * for a "decoding N of M nodes" readout. Not called for a node whose decode
   * is skipped by an abort.
   */
  readonly onProgress?: (progress: GradeProgress) => void;
  /**
   * The source octree's completeness, forwarded to {@link fullCloudGradeCoverage}
   * so a grade over a truncated hierarchy is never labelled "exact". Omitted by
   * pure-plan callers (tests grading an explicit node list) → treated as
   * complete, preserving the exhaustive/sampled behaviour for whole octrees.
   */
  readonly completeness?: OctreeCompleteness;
}): Promise<FullCloudGradeRun<G>> {
  const { nodes, decodeNode, grade, options, signal, onProgress, completeness } = args;

  const plan = buildSamplingPlan(nodes, options);

  // BUDGET GUARD (before any allocation): the planner always selects at least
  // one node, so a single huge first node becomes the whole plan even when its
  // count dwarfs the sample budget. Sizing `positions` at `sampledPoints * 3`
  // would then allocate multiple gigabytes on a path that never went through the
  // streaming scheduler's device-aware first-node guard. Refuse here, before the
  // Float32Array is created, so an oversized plan can never allocate.
  const refusal = sampleBudgetRefusal(plan);
  if (refusal) throw new FullCloudGradeRefusedError(refusal);

  const coverage = fullCloudGradeCoverage(plan, completeness);

  // Exact per-node header counts (COPC/EPT/OOC state them precisely) keyed by id,
  // so each decoded node can be checked against what the plan measured.
  const declaredById = new Map<string, number>();
  for (const n of nodes) declaredById.set(n.id, Math.max(0, n.pointCount));

  // Decode each selected node in plan order, copying its points STRAIGHT into one
  // pre-sized buffer and dropping the chunk reference immediately — so the sample
  // is never held twice (the old path kept every chunk in an array AND a second
  // merged copy, ~2× the sample's bytes at peak; this feature exists for large
  // streaming clouds, so that transient matters). The buffer is sized from the
  // plan's sampledPoints — the sum of the selected nodes' exact header counts —
  // and, because every node is verified to decode exactly its declared count, it
  // fills precisely with no reallocation.
  const positions = new Float32Array(plan.sampledPoints * 3);
  let offset = 0;
  let decodedNodes = 0;
  for (const id of plan.nodeIds) {
    if (signal?.aborted) throw new DOMException('Full-cloud grade aborted', 'AbortError');
    const chunk = await decodeNode(id, signal);
    // STRICT DECODE CHECK: the coverage percent and density back-scale were
    // computed from the PLAN's declared counts. A node that decodes a different
    // number of points than its header stated (a vanished/changed node, a short
    // read) would make that scale describe a sample the grade never decoded.
    // Hierarchy counts are exact, so fail cleanly rather than silently reweight.
    const declared = declaredById.get(id) ?? 0;
    if (chunk.length !== declared * 3) {
      throw new FullCloudGradeShortDecodeError(
        `Full-cloud grade: node ${id} decoded ${chunk.length / 3} points, but its header ` +
          `declared ${declared}. Hierarchy counts are exact; refusing to grade an ` +
          `inconsistent sample rather than report a coverage it never decoded.`,
      );
    }
    positions.set(chunk, offset);
    offset += chunk.length;
    decodedNodes++;
    onProgress?.({
      decodedNodes,
      totalNodes: plan.nodeIds.length,
      decodedPoints: offset / 3,
    });
  }

  // Every node decoded exactly its declared count, so `offset === positions.length`
  // and the whole buffer is the sample — no view/truncation. The result carries
  // only the small grade + coverage, never the positions, so the sample isn't
  // retained past the grade call.
  const grade_ = grade(positions, coverage.samplePointScale);
  return { coverage, grade: grade_ };
}
