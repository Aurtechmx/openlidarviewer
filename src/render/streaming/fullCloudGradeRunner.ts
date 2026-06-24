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

  // Decode each selected node in plan order, copying its points STRAIGHT into one
  // pre-sized buffer and dropping the chunk reference immediately — so the sample
  // is never held twice (the old path kept every chunk in an array AND a second
  // merged copy, ~2× the sample's bytes at peak; this feature exists for large
  // streaming clouds, so that transient matters). The buffer is sized from the
  // plan's sampledPoints — the sum of the selected nodes' exact header counts —
  // so it normally fits without reallocation.
  let positions = new Float32Array(plan.sampledPoints * 3);
  let offset = 0;
  let decodedNodes = 0;
  for (const id of plan.nodeIds) {
    if (signal?.aborted) throw new DOMException('Full-cloud grade aborted', 'AbortError');
    const chunk = await decodeNode(id, signal);
    if (offset + chunk.length > positions.length) {
      // A node decoded more points than its header advertised — grow once and
      // keep going rather than truncate (correctness over the rare extra copy).
      const grown = new Float32Array(Math.max(offset + chunk.length, positions.length * 2));
      grown.set(positions.subarray(0, offset));
      positions = grown;
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

  // Grade exactly the decoded span (offset ≤ capacity when a node decodes fewer
  // points than its header count). `subarray` is a view — no extra copy — and the
  // result carries only the small grade + coverage, never the positions, so the
  // sample isn't retained past the grade call.
  const sample = offset === positions.length ? positions : positions.subarray(0, offset);
  const grade_ = grade(sample, coverage.samplePointScale);
  return { coverage, grade: grade_ };
}
