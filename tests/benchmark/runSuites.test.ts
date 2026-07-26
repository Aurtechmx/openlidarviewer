/**
 * runSuites.test.ts — the entry point the `benchmark:*` commands invoke.
 *
 * WHY A VITEST FILE AND NOT A BARE NODE SCRIPT. The pipeline driver's provenance
 * path reads `__BUILD_IDENTITY__`, a Vite/Vitest `define`. Under plain `node`
 * that is a ReferenceError at MODULE LOAD — before any stage exists, so it
 * cannot even be reported as a failed stage; the process simply dies. Running
 * the suites under vitest is what supplies the define, and it is the precedent
 * the repo already set with `npm run repro`.
 *
 * WHY THE SUITES ARE ENV-GATED. `tests/benchmark/*.test.ts` is in the unit
 * bucket, which runs on every commit. A ten-run 250k suite and a five-tier
 * ladder do not belong there. Without `BENCHMARK_SUITES` this file asserts only
 * that the shipped configurations are valid — cheap, and worth having pinned.
 *
 * WHY THE WALL CLOCK LIVES HERE. Nothing under `benchmarks/` may read
 * `Date.now()` or `new Date()`; a source guard enforces it, because a hashed
 * artifact that embeds a timestamp can never reproduce. The manifest genuinely
 * needs start and completion times, so this file — outside the guarded tree —
 * takes them and hands them to the writer.
 */
import { describe, test, expect } from 'vitest';
import {
  REPRODUCIBILITY_CONFIG,
  SCALING_CONFIG,
  parseReproducibilityConfig,
  parseScalingConfig,
} from '../../benchmarks/runner/config';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { runScalingSuiteForConfig } from '../../benchmarks/runner/scalingIsolated';
import { writeResults } from '../../benchmarks/runner/writer';

/** Comma-separated suite ids, e.g. `reproducibility,scaling`. */
const requested = (process.env.BENCHMARK_SUITES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');

const wants = (id: string): boolean => requested.includes(id);

/**
 * The browser suite is out of scope for this runner and is NOT stubbed.
 *
 * A stub would put a row in the manifest that looks like a measurement nobody
 * took. Naming it as deliberately not run, with the reason, is the honest seam:
 * whoever adds the browser suite fills this in, and until then a reader of
 * `summary.md` sees "not run" rather than nothing at all.
 */
const NOT_RUN = [
  {
    suiteId: 'browser',
    reason:
      'GPU upload, first frame, frame rate and time-to-interaction need a browser; this runner is Node-only and reports no number for them',
  },
] as const;

describe('benchmark suites', () => {
  test('the shipped configurations are valid', () => {
    expect(parseReproducibilityConfig(REPRODUCIBILITY_CONFIG)).toEqual(REPRODUCIBILITY_CONFIG);
    expect(parseScalingConfig(SCALING_CONFIG)).toEqual(SCALING_CONFIG);
  });

  test.runIf(requested.length > 0)(
    'run the requested suites and write the result tree',
    () => {
      const startedAtUtc = new Date().toISOString();

      const reproducibility = wants('reproducibility')
        ? runReproducibilitySuite(parseReproducibilityConfig(REPRODUCIBILITY_CONFIG))
        : null;
      // Honours `config.isolation`: the shipped configuration runs each tier in
      // its own child process, so ladder order is not confounded with the
      // parent's heap growth and JIT state.
      const scaling = wants('scaling')
        ? runScalingSuiteForConfig(parseScalingConfig(SCALING_CONFIG))
        : null;

      const completedAtUtc = new Date().toISOString();
      const outcome = writeResults({
        command: `BENCHMARK_SUITES=${requested.join(',')} vitest run tests/benchmark/runSuites.test.ts`,
        startedAtUtc,
        completedAtUtc,
        reproducibility,
        scaling,
        notRun: NOT_RUN,
      });

      // Printed rather than only asserted: the tree's location is the one thing
      // an operator needs from a successful run.
      console.log(`benchmark results written to ${outcome.latestDir}`);
      console.log(`archived at ${outcome.archiveDir}`);

      // The suite verdicts ARE the test verdict, so a failing benchmark exits
      // non-zero without a second wrapper deciding what counts as failure.
      expect(reproducibility?.summary.failures ?? []).toEqual([]);
      expect(scaling?.summary.failures ?? []).toEqual([]);
    },
    // Generous: the 1M tier alone is seconds of real terrain work per run, and a
    // timeout here would destroy a measurement rather than report one.
    3_600_000,
  );
});
