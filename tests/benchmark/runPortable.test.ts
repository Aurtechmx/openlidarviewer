/**
 * runPortable.test.ts — the entry point `npm run benchmark:repro:portable`
 * invokes.
 *
 * It runs the existing reproducibility suite, unchanged and with the shipped
 * configuration, then writes two things from that single run: the ordinary
 * result tree `benchmark:verify` already checks, and this platform's leg of the
 * cross-platform comparison. One run behind both, so the leg and the tree can
 * never describe two different sets of measurements.
 *
 * A vitest file rather than a bare node script, for the reason `runSuites`
 * already is: the pipeline driver reads `__BUILD_IDENTITY__`, a Vite define,
 * and under plain node that is a ReferenceError at module load.
 *
 * The wall clock is read HERE, outside `benchmarks/`, because nothing in that
 * tree may read it. The manifests need start and completion times and this file
 * supplies them.
 */
import { describe, test, expect } from 'vitest';
import {
  REPRODUCIBILITY_CONFIG,
  parseReproducibilityConfig,
} from '../../benchmarks/runner/config';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { writeResults } from '../../benchmarks/runner/writer';
import { SUPPORTED_ENDIANNESS, detectEndianness } from '../../benchmarks/portability/preconditions';
import { writePlatformLeg } from '../../benchmarks/portability/writer';

const enabled = process.env.BENCHMARK_PORTABLE === '1';

/** Named as deliberately not run, so `summary.md` says so rather than nothing. */
const NOT_RUN = [
  {
    suiteId: 'scaling',
    reason:
      'the portable command records one seeded configuration so two platforms compare like with like; the scaling ladder is a separate experiment and is run by npm run benchmark:scaling',
  },
  {
    suiteId: 'browser',
    reason:
      'GPU upload, first frame, frame rate and time-to-interaction need a browser; this runner is Node-only and reports no number for them',
  },
] as const;

describe('benchmark:repro:portable', () => {
  test.runIf(enabled)(
    'record this platform as a leg of the cross-platform comparison',
    () => {
      // Checked before the suite runs, not after. A big-endian host would
      // produce different bytes for identical numbers in every raw typed-array
      // artifact, and a leg recorded from one would show up later as a science
      // mismatch, which names the wrong cause.
      const endianness = detectEndianness();
      expect(
        endianness,
        `this host reports ${endianness} byte order; cross-platform reproducibility is defined here for ${SUPPORTED_ENDIANNESS} hosts only`,
      ).toBe(SUPPORTED_ENDIANNESS);

      const startedAtUtc = new Date().toISOString();
      const reproducibility = runReproducibilitySuite(parseReproducibilityConfig(REPRODUCIBILITY_CONFIG));
      const completedAtUtc = new Date().toISOString();

      const command = 'npm run benchmark:repro:portable';
      const results = writeResults({
        command,
        startedAtUtc,
        completedAtUtc,
        reproducibility,
        scaling: null,
        notRun: NOT_RUN,
      });
      const leg = writePlatformLeg({
        reproducibility,
        command,
        startedAtUtc,
        completedAtUtc,
      });

      console.log(`benchmark results written to ${results.latestDir}`);
      console.log(`archived at ${results.archiveDir}`);
      console.log(`platform leg written to ${leg.dir} as ${leg.record.platformId}`);
      console.log(`source cloud sha256: ${leg.record.fixture.sourceCloudHash ?? 'absent'}`);

      // The suite's verdict is the test's verdict, so a platform that cannot
      // reproduce its own outputs never becomes a leg of a cross-platform
      // claim.
      expect(reproducibility.summary.failures).toEqual([]);
      expect(leg.record.internal.pass).toBe(true);
      expect(leg.record.fixture.sourceCloudHash).not.toBeNull();
    },
    3_600_000,
  );

  test.runIf(!enabled)('is inert until BENCHMARK_PORTABLE=1', () => {
    expect(detectEndianness()).toBe(SUPPORTED_ENDIANNESS);
  });
});
