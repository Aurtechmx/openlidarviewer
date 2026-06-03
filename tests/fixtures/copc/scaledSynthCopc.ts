/**
 * scaledSynthCopc.ts — scaled synthetic COPC builder for stress harnesses.
 *
 * Where {@link buildSyntheticCopc} is given an explicit node list,
 * {@link buildScaledSyntheticCopc} generates a uniformly-distributed octree
 * hierarchy of any target point count: 1 M, 10 M, 100 M, 250 M, 500 M.
 *
 * The generator is deterministic for a given `seed` (mulberry32 PRNG) and
 * produces placeholder chunk bytes, so even a 500 M-point fixture stays a
 * small ArrayBuffer — the scheduler / cache stress runs through the FAKE
 * `ChunkDecoder`, never through laz-perf, so chunk payloads can be dummies.
 *
 * Pure — no DOM, no three.js — runs in Node for the test suite.
 */

import { buildSyntheticCopc } from './synthCopc';
import type { SynthCopcOptions, SynthCopcResult, SynthNode } from './synthCopc';

/** Options for {@link buildScaledSyntheticCopc}. */
export interface ScaledSynthOptions {
  /** Target total source point count across the whole hierarchy. */
  targetPoints: number;
  /**
   * Approximate points per data node. Smaller values produce more nodes —
   * a stronger scheduler-stress test. Default: 5_000 (autzen-ish density).
   */
  pointsPerNode?: number;
  /**
   * Override the octree max depth. When omitted, derived from
   * `targetPoints / pointsPerNode` to give enough nodes to cover the budget.
   */
  maxDepth?: number;
  /** Seed for deterministic point distribution. Default: 1. */
  seed?: number;
  /**
   * Base options forwarded to {@link buildSyntheticCopc} (PDRF, scale,
   * offset, octree cube, spacing). `nodes`, `pages`, and `corrupt` are
   * intentionally not forwarded — they are generated here.
   */
  base?: Omit<SynthCopcOptions, 'nodes' | 'pages' | 'corrupt'>;
}

/** A scaled synthetic-COPC result plus the generated octree shape. */
export interface ScaledSynthResult extends SynthCopcResult {
  /** Number of nodes generated across every depth. */
  nodeCount: number;
  /** Octree max depth used. */
  maxDepth: number;
  /** The points-per-node target used (the per-node count varies ±25 %). */
  pointsPerNode: number;
}

/** Sum of 8^0 + 8^1 + … + 8^D — total nodes in a full octree up to depth D. */
function totalNodesUpTo(maxDepth: number): number {
  // Closed form: (8^(D+1) − 1) / 7.
  let total = 0;
  for (let d = 0; d <= maxDepth; d++) total += Math.pow(8, d);
  return total;
}

/** Smallest depth D such that totalNodesUpTo(D) >= desired. */
function deriveMaxDepth(desiredNodeCount: number, hardCap = 8): number {
  let total = 0;
  for (let d = 0; d <= hardCap; d++) {
    total += Math.pow(8, d);
    if (total >= desiredNodeCount) return d;
  }
  return hardCap;
}

/** A tiny deterministic 32-bit PRNG — mulberry32. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a synthetic COPC file with a generated octree hierarchy sized to a
 * target source point count. The hierarchy is uniform (every node at every
 * depth up to `maxDepth` exists), with per-node point counts varied by ±25 %
 * around the average — enough variation to exercise the scheduler's score
 * ordering without breaking the total.
 *
 * The result is deterministic for a given `seed`.
 */
export function buildScaledSyntheticCopc(
  options: ScaledSynthOptions,
): ScaledSynthResult {
  const target = Math.max(1, Math.floor(options.targetPoints));
  const pointsPerNode = Math.max(1, Math.floor(options.pointsPerNode ?? 5_000));
  const desiredNodeCount = Math.max(1, Math.ceil(target / pointsPerNode));
  const maxDepth = options.maxDepth ?? deriveMaxDepth(desiredNodeCount);
  const totalNodes = totalNodesUpTo(maxDepth);
  const seed = options.seed ?? 1;

  const rng = mulberry32(seed);
  const avg = target / totalNodes;

  const nodes: SynthNode[] = [];
  let remaining = target;
  let emitted = 0;
  for (let d = 0; d <= maxDepth; d++) {
    const dim = 1 << d;
    for (let x = 0; x < dim; x++) {
      for (let y = 0; y < dim; y++) {
        for (let z = 0; z < dim; z++) {
          emitted++;
          let pc: number;
          if (emitted === totalNodes) {
            // The final node absorbs whatever rounding left over, so the
            // total always equals `target` exactly.
            pc = Math.max(0, remaining);
          } else {
            // ±25 % variation, clamped against the remaining budget.
            const noise = 1 + (rng() - 0.5) * 0.5;
            pc = Math.max(0, Math.floor(avg * noise));
            if (pc > remaining) pc = remaining;
          }
          remaining -= pc;
          nodes.push({ key: [d, x, y, z], pointCount: pc });
        }
      }
    }
  }

  const buf = buildSyntheticCopc({ ...(options.base ?? {}), nodes });
  return {
    ...buf,
    nodeCount: totalNodes,
    maxDepth,
    pointsPerNode,
  };
}

/** The standard stress tiers — convenience labels for the harness. */
export const STRESS_TIERS = {
  '1M': 1_000_000,
  '10M': 10_000_000,
  '100M': 100_000_000,
  '250M': 250_000_000,
  '500M': 500_000_000,
  /**
   * Extreme-scale tier — 1 billion synthetic points. Generated with
   * a larger `pointsPerNode` (50K) so the hierarchy stays at ~20K nodes
   * instead of generating 200K nodes the synthetic builder would balloon to
   * at default density. The hierarchy density is irrelevant to what the
   * stress harness measures (scheduler residency bounds + thrash-free
   * eviction); larger per-node payloads better match real-world COPC files
   * at this scale, where AVERAGE node density rises with depth anyway.
   */
  '1B': 1_000_000_000,
} as const;

/** Stress-tier names — `'1M' | '10M' | '100M' | '250M' | '500M' | '1B'`. */
export type StressTier = keyof typeof STRESS_TIERS;

/**
 * Per-tier `pointsPerNode` override. Keep total node count
 * tractable at the largest tiers (the synthetic generator scales linearly
 * with node count; 1B points at the default 5K/node would be 200K nodes
 * which is fine for the data structure but inflates the time the test
 * spends walking it). Real-world COPC files at this scale have similar
 * average density (50K-200K points per leaf node).
 */
export const STRESS_TIER_POINTS_PER_NODE: Partial<Record<StressTier, number>> = {
  '500M': 25_000,
  '1B': 50_000,
};
