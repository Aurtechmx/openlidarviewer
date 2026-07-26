/**
 * verifyResults.test.ts — the entry point `npm run benchmark:verify` invokes.
 *
 * Re-runs no measurement. It reads `benchmark-results/latest/`, recomputes every
 * published statistic from the raw values, re-renders the Markdown and CSV from
 * the published JSON, and checks every file against the manifest's SHA-256.
 *
 * Runs under vitest for the same reason the suites do — and, unlike them, for a
 * second reason worth stating: a failed check has to exit non-zero, and vitest
 * already does that faithfully.
 *
 * Without `BENCHMARK_VERIFY=1` this file asserts nothing about a result tree, so
 * the unit bucket does not fail on a checkout that has never run a benchmark.
 */
import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { LATEST_DIR } from '../../benchmarks/runner/writer';
import { verifyResultsDir } from '../../benchmarks/runner/verify';

const enabled = process.env.BENCHMARK_VERIFY === '1';
const dir = process.env.BENCHMARK_RESULTS_DIR ?? LATEST_DIR;

describe('benchmark:verify', () => {
  test.runIf(enabled)('the published result tree is internally consistent', () => {
    // A missing tree is a failure, not a skip: `benchmark:verify` was asked to
    // verify something, and "there was nothing there" is the answer that must
    // exit non-zero rather than pass quietly.
    expect(existsSync(dir), `no benchmark results at ${dir} — run npm run benchmark:quick first`).toBe(
      true,
    );

    const outcome = verifyResultsDir(dir);
    for (const line of outcome.checked) console.log(`ok: ${line}`);
    for (const line of outcome.problems) console.error(`FAIL: ${line}`);
    expect(outcome.problems).toEqual([]);
  }, 600_000);

  test.runIf(!enabled)('is inert until BENCHMARK_VERIFY=1', () => {
    expect(typeof verifyResultsDir).toBe('function');
  });
});
