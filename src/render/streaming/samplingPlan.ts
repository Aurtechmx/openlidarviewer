/**
 * samplingPlan.ts
 *
 * The pure decision core behind "analyse the FULL cloud, not just the preview"
 *. A COPC/EPT octree is too large to decode whole on demand, so
 * to compute an honest full-cloud grade we decode a REPRESENTATIVE SAMPLE: a
 * breadth-first slice of the hierarchy within a point/byte budget. This module
 * decides WHICH nodes to decode; the actual range-fetch + LAZ decode is a
 * worker-bound layer that consumes this plan.
 *
 * Why breadth-first (shallow depths first): in a COPC octree, shallow nodes are
 * a spatially-even, decimated sample of the whole extent, while deep nodes add
 * local density. Taking depths in order therefore yields a sample whose spatial
 * COVERAGE tracks the budget — the right bias for a representative grade, versus
 * a depth-first dive that would over-sample one corner.
 *
 * Honesty contract: the plan reports whether it covers the WHOLE tree
 * (`exhaustive`) or had to stop at the budget (`exhaustive: false`), plus the
 * fraction of all points the sample represents, so the caller can label a
 * full-cloud grade as exact vs. sampled rather than implying completeness.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic (stable tie-break).
 */

/** The minimal per-node facts the plan needs (a projection of StreamingNodeRecord). */
export interface SampleNode {
  /** Deterministic node id (`"depth-x-y-z"`). */
  readonly id: string;
  /** Octree depth (root = 0). */
  readonly depth: number;
  /** Points in this node's chunk. */
  readonly pointCount: number;
  /** Compressed chunk size in bytes (the decode cost). */
  readonly byteSize: number;
}

export interface SamplingPlanOptions {
  /** Stop once the cumulative sampled point count reaches this. Default 2,000,000. */
  readonly maxPoints?: number;
  /** Stop once the cumulative compressed bytes reach this. Default Infinity (no byte cap). */
  readonly maxBytes?: number;
  /** Never decode nodes deeper than this. Default Infinity (all depths eligible). */
  readonly maxDepth?: number;
}

export interface SamplingPlan {
  /** Node ids to decode, in decode order (shallow → deep). */
  readonly nodeIds: string[];
  /** Sum of `pointCount` over the selected nodes. */
  readonly sampledPoints: number;
  /** Sum of `byteSize` over the selected nodes (the decode cost). */
  readonly sampledBytes: number;
  /** Sum of `pointCount` over ALL input nodes. */
  readonly totalPoints: number;
  /** `sampledPoints / totalPoints`, 0..1 (0 when the tree is empty). */
  readonly coverageFraction: number;
  /** Deepest octree level the plan reaches. -1 when nothing is selected. */
  readonly maxDepthReached: number;
  /**
   * True only when EVERY input node is selected — i.e. the sample IS the whole
   * cloud and a grade computed from it is exact, not sampled.
   */
  readonly exhaustive: boolean;
}

const DEFAULT_MAX_POINTS = 2_000_000;

/**
 * Build a breadth-first sampling plan over an octree's node records within a
 * point/byte/depth budget. Nodes are taken shallow-first (ties broken by larger
 * node, then id, for determinism); selection stops at the first budget hit. At
 * least one node is always selected when the tree is non-empty and the budget is
 * positive, so a full-cloud pass never decodes nothing.
 */
export function buildSamplingPlan(
  nodes: readonly SampleNode[],
  options: SamplingPlanOptions = {},
): SamplingPlan {
  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  const maxBytes = options.maxBytes ?? Infinity;
  const maxDepth = options.maxDepth ?? Infinity;

  const totalPoints = nodes.reduce((s, n) => s + Math.max(0, n.pointCount), 0);

  // Eligible = within the depth cap. Sorted breadth-first, deterministic.
  const eligible = nodes
    .filter((n) => n.depth <= maxDepth)
    .slice()
    .sort((a, b) => a.depth - b.depth || b.pointCount - a.pointCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const nodeIds: string[] = [];
  let sampledPoints = 0;
  let sampledBytes = 0;
  let maxDepthReached = -1;

  for (const n of eligible) {
    // Stop at the first budget already met — but only after at least one node,
    // so a positive budget always yields a non-empty plan.
    if (nodeIds.length > 0 && (sampledPoints >= maxPoints || sampledBytes >= maxBytes)) break;
    nodeIds.push(n.id);
    sampledPoints += Math.max(0, n.pointCount);
    sampledBytes += Math.max(0, n.byteSize);
    if (n.depth > maxDepthReached) maxDepthReached = n.depth;
  }

  return {
    nodeIds,
    sampledPoints,
    sampledBytes,
    totalPoints,
    coverageFraction: totalPoints > 0 ? Math.min(1, sampledPoints / totalPoints) : 0,
    maxDepthReached,
    exhaustive: nodeIds.length === nodes.length,
  };
}
