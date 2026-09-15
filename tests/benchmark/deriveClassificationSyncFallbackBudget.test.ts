/**
 * deriveClassificationSyncFallbackBudget.test.ts: how large a cloud the
 * synchronous classifier fallback may take before it stops being a recovery
 * and becomes a freeze.
 *
 * `deriveClassificationAsync` runs `deriveClassification` on the main thread
 * when the classifier worker fails. The ceiling on that path has to come from a
 * measurement, so this records wall time for the pure TS classifier over a
 * point ladder on a realistic 1000 m extent.
 *
 * The budget is 200 ms, the same one the terrain ladder uses: long enough to be
 * worth attempting, short enough that a user who triggers the fallback sees a
 * hitch rather than a hang.
 *
 * Node timings are a PROXY for the browser main thread, not the same number.
 * Node and a browser tab run the same V8 on different heaps and under different
 * scheduling, so treat the crossing point as an order-of-magnitude bound.
 *
 * Off by default. Run it with
 * `SYNC_FALLBACK_BENCH=1 npx vitest run tests/benchmark/deriveClassificationSyncFallbackBudget.test.ts`.
 * The frozen numbers live in docs/validation/sync-fallback-budget-baseline.json.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { deriveClassification } from '../../src/render/class/deriveClassification';
import { makeTerrainBenchCloud } from '../helpers/terrainBenchCloud';

const ENABLED = process.env.SYNC_FALLBACK_BENCH === '1';

/** The main-thread stall a fallback is allowed to cost, in milliseconds. */
const BUDGET_MS = 200;

const POINT_LADDER = [10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];

function bestOf(runs: number, body: () => void): number {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    body();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const pad = (s: string | number, w: number): string => String(s).padStart(w);
const print = (line: string): void => void process.stdout.write(line + '\n');

describe.skipIf(!ENABLED)('synchronous classifier fallback budget', () => {
  it(
    'records where the main-thread classifier crosses the budget',
    () => {
      print(`\nclassifier sync-fallback ladder, budget ${BUDGET_MS} ms, best-of-3`);
      print('  ' + [pad('points', 8), pad('ms', 9)].join(' | '));
      for (const n of POINT_LADDER) {
        const cloud = makeTerrainBenchCloud(n);
        const ms = bestOf(3, () => {
          deriveClassification(cloud, n, {});
        });
        print('  ' + [pad(n, 8), pad(ms.toFixed(1), 9)].join(' | '));
        expect(Number.isFinite(ms)).toBe(true);
      }
    },
    900_000,
  );
});
