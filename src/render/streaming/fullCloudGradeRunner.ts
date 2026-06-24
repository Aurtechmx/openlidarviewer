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
import { fullCloudGradeCoverage, type FullCloudGradeCoverage } from './fullCloudGrade';

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
}): Promise<FullCloudGradeRun<G>> {
  const { nodes, decodeNode, grade, options, signal, onProgress } = args;

  const plan = buildSamplingPlan(nodes, options);
  const coverage = fullCloudGradeCoverage(plan);

  // Decode each selected node in plan order, accumulating chunks first so the
  // final buffer is allocated exactly once.
  const chunks: Float32Array[] = [];
  let totalLen = 0;
  for (const id of plan.nodeIds) {
    if (signal?.aborted) throw new DOMException('Full-cloud grade aborted', 'AbortError');
    const chunk = await decodeNode(id, signal);
    chunks.push(chunk);
    totalLen += chunk.length;
    onProgress?.({
      decodedNodes: chunks.length,
      totalNodes: plan.nodeIds.length,
      decodedPoints: totalLen / 3,
    });
  }

  // Assemble the decoded chunks into one buffer purely to grade them, then let
  // it go — the result carries only the (small) grade + coverage, never the
  // multi-MB positions, so a large sample isn't retained past the grade call.
  const positions = new Float32Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    positions.set(chunk, offset);
    offset += chunk.length;
  }

  const grade_ = grade(positions, coverage.samplePointScale);
  return { coverage, grade: grade_ };
}
