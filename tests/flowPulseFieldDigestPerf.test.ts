/**
 * flowPulseFieldDigestPerf.test.ts — the field digest's cost against routing's,
 * at the scale a real session hits.
 *
 * `runFlowPulse` already pays for D8 plus accumulation on every run; the field
 * digest is new work laid on top of that. What matters for a session is
 * whether hashing becomes a cost worth noticing next to routing itself, not
 * an absolute millisecond figure that a different machine would read
 * differently. So this times both over the same 1,000,000-cell grid, over
 * several runs, and reports the median of each — following the timing
 * convention in tests/terrainPipelineBenchmark.test.ts: logged for a human to
 * read, not asserted to a tight bound that would flake on a loaded CI box.
 * The one assertion is a loose ceiling wide enough to survive a slow runner
 * and narrow enough to catch a real algorithmic regression, such as the
 * digest accidentally falling back to JSON-stringifying the arrays it hashes.
 */
import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { flowAccumulation } from '../src/simulation/flowPulse/flowAccumulation';
import { flowFieldDigest } from '../src/simulation/flowPulse/flowFieldDigest';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function perf(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A 1000×1000 grid with real relief, so D8 compares real gradients rather
 *  than routing a flat plane it would resolve in one branch every cell. */
function millionCellGrid(): FlowGrid {
  const cols = 1000;
  const rows = 1000;
  const n = cols * rows;
  const z = new Float32Array(n);
  const valid = new Uint8Array(n).fill(1);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      z[row * cols + col] = Math.sin(col * 0.013) * 5 + Math.cos(row * 0.017) * 5 + (cols - col) * 0.001;
    }
  }
  return { z, valid, cols, rows, cellMetresX: 1, cellMetresY: 1 };
}

describe('field digest cost at 1,000,000 cells', () => {
  it('reports the hashing and routing medians, and hashing stays within routing\'s order of magnitude', () => {
    const grid = millionCellGrid();
    const RUNS = 5;

    const routeMs: number[] = [];
    const hashMs: number[] = [];
    let digest = '';

    for (let i = 0; i < RUNS; i++) {
      const t0 = perf();
      const routed = d8Flow(grid);
      const accumulation = flowAccumulation(grid, routed);
      routeMs.push(perf() - t0);

      const t1 = perf();
      digest = flowFieldDigest(grid, routed, accumulation, null);
      hashMs.push(perf() - t1);
    }

    const routeMedian = median(routeMs);
    const hashMedian = median(hashMs);

    // eslint-disable-next-line no-console
    console.log(
      `[flowFieldDigest perf] 1,000,000 cells, n=${RUNS}: `
      + `routing median ${routeMedian.toFixed(1)} ms, hashing median ${hashMedian.toFixed(1)} ms `
      + `(hash/route ratio ${(hashMedian / routeMedian).toFixed(2)})`,
    );

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // A regression guard, not a tight bound: hashing a million routed cells
    // should stay a small multiple of what routing them cost, never the
    // dominant expense of a run. Machine-dependent, so the margin is wide.
    expect(hashMedian).toBeLessThan(Math.max(routeMedian * 10, 3000));
  });
});
