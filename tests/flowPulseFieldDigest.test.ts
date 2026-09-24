/**
 * flowFieldDigest.test.ts: the digest binds the routed field, not its summary.
 *
 * A run's summary is a handful of counts and maxima, and two materially
 * different receiver or accumulation arrays can agree on every one of them.
 * The tests below construct exactly that: two D8/accumulation results with
 * identical sink, flat and outlet counts and an identical maxUpstreamCells,
 * but a different receiver — the case the digest exists to catch — and check
 * that they seal to different bytes. The pinned fixture documents the byte
 * layout itself, so a change to the encoding fails here rather than only in
 * whichever export happens to compare an old digest against a new one.
 */
import { describe, expect, it } from 'vitest';

import { flowFieldDigest, FLOW_FIELD_DIGEST_ENCODING } from '../src/simulation/flowPulse/flowFieldDigest';
import type { D8Result } from '../src/simulation/flowPulse/d8Flow';
import type { AccumulationResult } from '../src/simulation/flowPulse/flowAccumulation';
import type { PriorityFloodResult } from '../src/simulation/flowPulse/priorityFlood';

const grid = { cols: 2, rows: 2 };

/** Flow east: 0→1 (outlet), 2→3 (outlet). Sink 0, flat 0, outlet 2, max upstream 2. */
const flowsEast: D8Result = {
  receiver: Int32Array.from([1, -1, 3, -1]),
  direction: Int8Array.from([0, -1, 0, -1]),
  status: Uint8Array.from([0, 4, 0, 4]),
  sinkCount: 0,
  flatCount: 0,
  outletCount: 2,
};
const flowsEastAccumulation: AccumulationResult = {
  upstreamCells: Uint32Array.from([1, 2, 1, 2]),
  drainedCells: 4,
  unresolvedCells: 0,
};

/**
 * Flow south instead: 0→2 (outlet), 1→3 (outlet). Same sink/flat/outlet
 * counts and the same maxUpstreamCells (2) as `flowsEast`, but every cell
 * sends its flow somewhere else and a different pair of cells is the outlet.
 * A digest built from the summary alone cannot tell these two apart.
 */
const flowsSouth: D8Result = {
  receiver: Int32Array.from([2, 3, -1, -1]),
  direction: Int8Array.from([2, 2, -1, -1]),
  status: Uint8Array.from([0, 0, 4, 4]),
  sinkCount: 0,
  flatCount: 0,
  outletCount: 2,
};
const flowsSouthAccumulation: AccumulationResult = {
  upstreamCells: Uint32Array.from([1, 1, 2, 2]),
  drainedCells: 4,
  unresolvedCells: 0,
};

function conditionedOf(z: readonly number[]): PriorityFloodResult {
  return {
    z: Float32Array.from(z),
    cellsRaised: 1,
    maxFillDepth: 0.5,
    fillDepthSum: 0.5,
    epsilonAbsorbed: 0,
    cellsUnreachable: 0,
  };
}

describe('the field digest catches what the summary cannot', () => {
  it('gives identical fields identical digests', () => {
    const a = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, null);
    const b = flowFieldDigest(
      grid,
      { ...flowsEast, receiver: Int32Array.from(flowsEast.receiver) },
      { ...flowsEastAccumulation, upstreamCells: Uint32Array.from(flowsEastAccumulation.upstreamCells) },
      null,
    );
    expect(a).toBe(b);
  });

  it('gives two materially different fields with equal summary figures different digests', () => {
    // Same sinkCount, flatCount, outletCount and max(upstreamCells) on both
    // sides — this is the collision the summary-only digest could not see.
    expect(flowsEast.sinkCount).toBe(flowsSouth.sinkCount);
    expect(flowsEast.flatCount).toBe(flowsSouth.flatCount);
    expect(flowsEast.outletCount).toBe(flowsSouth.outletCount);
    expect(Math.max(...flowsEastAccumulation.upstreamCells))
      .toBe(Math.max(...flowsSouthAccumulation.upstreamCells));

    const east = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, null);
    const south = flowFieldDigest(grid, flowsSouth, flowsSouthAccumulation, null);
    expect(east).not.toBe(south);
  });

  it('gives a raw run and a conditioned run over the same routed field different digests', () => {
    const raw = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, null);
    const conditioned = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, conditionedOf([2, 1, 2, 1]));
    expect(raw).not.toBe(conditioned);
  });

  it('gives two conditioned runs with different elevations different digests', () => {
    const a = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, conditionedOf([2, 1, 2, 1]));
    const b = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, conditionedOf([2, 1.5, 2, 1]));
    expect(a).not.toBe(b);
  });

  it('rejects an array that does not match cols×rows rather than hashing past its end', () => {
    expect(() => flowFieldDigest(
      grid,
      { ...flowsEast, receiver: Int32Array.from([1, -1, 3]) },
      flowsEastAccumulation,
      null,
    )).toThrow(RangeError);
  });
});

describe('the encoding is pinned', () => {
  it('names its version in the domain-separation header', () => {
    expect(FLOW_FIELD_DIGEST_ENCODING).toBe('olv.simulation.terrain-flow.field-digest.v1');
  });

  it('reproduces a hand-computed digest for a tiny fixture', () => {
    // A 2×2 grid, [[2,1],[2,1]]: both rows fall east, both east cells are
    // outlets. Cross-checked against an independent SHA-256 over the same
    // byte layout the module doc describes (header, cols, rows, conditioned
    // flag, receiver Int32 LE, direction, status, upstream Uint32 LE).
    const digest = flowFieldDigest(grid, flowsEast, flowsEastAccumulation, null);
    expect(digest).toBe('d5ed5dfb36addb18253ec6b117b6ea77e583afe9192816e09f54c52375e53619');
  });
});
