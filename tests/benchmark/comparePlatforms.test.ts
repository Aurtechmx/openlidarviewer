/**
 * comparePlatforms.test.ts — the entry point `npm run benchmark:compare-platforms`
 * invokes.
 *
 * It takes two or more platform legs, verifies each one against its own
 * manifest, compares their science-scoped outputs at a tolerance of exactly
 * zero, writes the comparison tree, and re-derives that tree to prove the
 * published files follow from the records inside it.
 *
 * No measurement is taken here. Every number in the output comes off a leg that
 * some machine recorded and signed with a manifest.
 *
 * `BENCHMARK_PORTABILITY_DIRS` names the legs, comma-separated. Left unset, the
 * command uses whatever legs already sit under `benchmark-results/portability/`
 * — which on a developer machine is the one leg that machine produced, and the
 * report says so rather than implying a comparison happened.
 *
 * `BENCHMARK_REQUIRE_PLATFORMS` names the platform ids that must be present.
 * CI sets both legs there, so a missing leg fails the job instead of quietly
 * yielding a single-platform result that reads like a cross-platform one.
 */
import { describe, test, expect } from 'vitest';
import {
  PORTABILITY_DIR,
  findPlatformLegs,
  verifyPortabilityDir,
  writeComparison,
} from '../../benchmarks/portability/writer';
import { comparePlatforms } from '../../benchmarks/portability/compare';

const enabled = process.env.BENCHMARK_COMPARE === '1';

function listed(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

describe('benchmark:compare-platforms', () => {
  test.runIf(enabled)(
    'compare the recorded platform legs and publish the result',
    () => {
      const explicit = listed('BENCHMARK_PORTABILITY_DIRS');
      const legDirs = explicit.length > 0 ? explicit : findPlatformLegs(PORTABILITY_DIR);
      expect(
        legDirs.length,
        `no platform legs found — run npm run benchmark:repro:portable first, or set BENCHMARK_PORTABILITY_DIRS`,
      ).toBeGreaterThan(0);

      const requirePlatforms = listed('BENCHMARK_REQUIRE_PLATFORMS');
      const startedAtUtc = new Date().toISOString();
      const outcome = writeComparison({
        legDirs,
        command: 'npm run benchmark:compare-platforms',
        startedAtUtc,
        completedAtUtc: new Date().toISOString(),
        compare: { requirePlatforms },
      });

      for (const line of outcome.checked) console.log(`ok: ${line}`);
      for (const line of outcome.problems) console.error(`FAIL: ${line}`);
      expect(outcome.problems).toEqual([]);

      const comparison = outcome.comparison;
      expect(comparison).not.toBeNull();
      if (comparison === null) return;

      console.log(`comparison written to ${outcome.dir}`);
      console.log(`status: ${comparison.status}`);
      console.log(`platforms: ${comparison.platforms.join(', ')}`);
      console.log(
        `source cloud: ${comparison.fixture.identical ? 'byte-identical on every platform' : 'DIFFERS between platforms'}`,
      );
      console.log(
        `science: ${comparison.science.hashesMismatched} of ${comparison.science.hashesCompared} hashes and ${comparison.science.scalarsMismatched} of ${comparison.science.scalarsCompared} scalars differ`,
      );
      console.log(`cross-platform claim established: ${comparison.claimEstablished}`);
      for (const failure of comparison.preconditionFailures) console.error(`precondition: ${failure}`);
      for (const mismatch of comparison.fixture.mismatches) console.error(`fixture: ${mismatch.field}`);
      for (const mismatch of comparison.science.mismatches) console.error(`science: ${mismatch.field}`);

      // The published tree must follow from the legs inside it. Checking this
      // in the same command that wrote it catches a renderer that drifted from
      // the document, before the tree is ever uploaded anywhere.
      const verified = verifyPortabilityDir(outcome.dir, { requirePlatforms });
      for (const line of verified.problems) console.error(`FAIL: ${line}`);
      expect(verified.problems).toEqual([]);

      // Scientific divergence fails the command. A single-platform run does
      // not: it is an honest outcome that establishes nothing cross-platform,
      // and the report says exactly that.
      expect(comparison.ok, `comparison status is ${comparison.status}`).toBe(true);
    },
    600_000,
  );

  test.runIf(!enabled)('is inert until BENCHMARK_COMPARE=1', () => {
    expect(typeof comparePlatforms).toBe('function');
  });
});
