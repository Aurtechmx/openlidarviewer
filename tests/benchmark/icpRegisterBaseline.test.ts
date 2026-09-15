/**
 * icpRegisterBaseline.test.ts: wall time of the live planar ICP.
 *
 * `alignEpochClouds` hands `icpRegister` up to a few thousand sampled points
 * per epoch and lets it run 25 iterations. This times the solver alone on a
 * size ladder with a known yaw and translation to recover, best of three,
 * so a change to its correspondence search can be judged on the whole fit
 * and not on a nearest-neighbour microbenchmark. Gated on `ICP_BENCH=1`.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { icpRegister, applyIcp, type Vec3 } from '../../src/terrain/change/icpRegister';

const ENABLED = process.env.ICP_BENCH === '1';
const SIZES = (process.env.ICP_BENCH_SIZES ?? '250,500,1000,1500,3000').split(',').map(Number);
const RUNS = 3;

function cloud(n: number, seed: number): Vec3[] {
  let s = seed >>> 0;
  const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 0xffffffff);
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) pts.push([rnd() * 200, rnd() * 200, rnd() * 20]);
  return pts;
}

describe('icpRegister cost', () => {
  const run = ENABLED ? it : it.skip;
  run(
    'times a full fit across a size ladder',
    () => {
      // eslint-disable-next-line no-console
      console.log(`\nicpRegister: sizes ${SIZES.join(',')} points per cloud, 25 iterations, best of ${RUNS}`);
      for (const n of SIZES) {
        const src = cloud(n, 7);
        const tgt = src.map((p) => applyIcp({ yawRad: 0.04, translation: [3, -2, 0.5] }, p));
        const times: number[] = [];
        let iterations = 0;
        for (const trim of [1, 0.8]) {
          for (let r = 0; r < RUNS; r++) {
            const t0 = performance.now();
            const res = icpRegister(src, tgt, { maxIterations: 25, tolerance: 0, trimFraction: trim });
            times.push(performance.now() - t0);
            iterations = res.iterations;
            expect(res.degenerate).toBe(false);
          }
          // eslint-disable-next-line no-console
          console.log(
            `  ${String(n).padStart(5)} pts  trim ${trim}  best ${Math.min(...times).toFixed(0).padStart(6)} ms  iterations ${iterations}  runs [${times.map((t) => t.toFixed(0)).join(', ')}]`,
          );
          times.length = 0;
        }
      }
    },
    3_600_000,
  );
});
