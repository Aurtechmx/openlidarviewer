/**
 * forcedGc.test.ts — does `--expose-gc` actually reach the process that runs a
 * pipeline?
 *
 * WHY THIS FILE EXISTS. The suites record `forcedGcAvailable` per run and, by
 * design, never fail when it is false — so a GC-controlled run whose flag went
 * missing produces a complete, plausible, PASSING result tree that is silently
 * the default-GC measurement wearing the other label. Nothing else in the
 * repository would notice. This test is the thing that notices: when
 * `BENCHMARK_FORCE_GC` is set it asserts `global.gc` is really here, inside a
 * vitest worker, which is the only process whose opinion matters.
 *
 * The flag has to survive two hops — the vitest worker the suite runs in, and
 * the grandchild worker of the child `vitest run` that `scalingIsolated.ts`
 * spawns per tier. Both hops are covered because this file IS a suite file: it
 * runs in a worker, and the env var it keys off is the same one the config
 * turns into an `execArgv` entry for every worker in every process.
 *
 * Unset, the assertion is skipped rather than inverted. A developer may well
 * have `--expose-gc` on for their own reasons and that is not a failure.
 */
import { describe, test, expect } from 'vitest';
import { FORCED_GC_ENV_VAR, forcedGcRequested } from '../../benchmarks/runner/gcMode';

describe('forced GC plumbing', () => {
  test('reports what this worker actually has', () => {
    // Printed unconditionally: proving the flag arrived is a thing an operator
    // has to be able to SEE, not infer from a green tick.
    console.log(
      `forced GC: ${FORCED_GC_ENV_VAR}=${JSON.stringify(process.env[FORCED_GC_ENV_VAR] ?? null)}, ` +
        `typeof global.gc === '${typeof (globalThis as { gc?: unknown }).gc}', ` +
        `execArgv=${JSON.stringify(process.execArgv)}`,
    );
    expect(typeof forcedGcRequested()).toBe('boolean');
  });

  test.runIf(forcedGcRequested())(
    'global.gc is a function in this worker when forced GC was requested',
    () => {
      expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function');
    },
  );
});
