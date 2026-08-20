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
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  LOADER_COMPARISON_CONFIG,
  REPRODUCIBILITY_CONFIG,
  SCALING_CONFIG,
  parseLoaderComparisonConfig,
  parseReproducibilityConfig,
  parseScalingConfig,
} from '../../benchmarks/runner/config';
import { runReproducibilitySuite } from '../../benchmarks/runner/reproducibility';
import { runScalingSuiteForConfig } from '../../benchmarks/runner/scalingIsolated';
import {
  runLoaderComparisonSuite,
  type CompetitorProbe,
} from '../../benchmarks/runner/loaderComparison';
import { writeResults } from '../../benchmarks/runner/writer';

/**
 * The competitor decoder, built HERE rather than inside the suite.
 *
 * Everything under `benchmarks/` may import only `node:` builtins and relative
 * paths (a source guard enforces it so the tree bundles in a browser), so the
 * bare `@loaders.gl/las` import cannot live there. This entry point is outside
 * the guarded tree — it already takes the wall clock the writer needs — so it is
 * where the competitor is loaded and injected. Absent the dependency the loader
 * suite still measures OLV and reports the competitor column unavailable, never
 * a fabricated number.
 */
/** The installed competitor version, read from its package.json for provenance. */
function competitorVersion(): string {
  try {
    // Resolve the package's real entry (honouring hoisting), then walk up to the
    // `package.json` that names it — the `exports` map blocks importing that file
    // directly, so it is read from disk. The version is provenance the manifest
    // records, not something to guess, so any failure lands on 'unknown'.
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve('@loaders.gl/las'));
    for (let hops = 0; hops < 8; hops++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === '@loaders.gl/las' && typeof pkg.version === 'string') return pkg.version;
      } catch {
        /* not this directory's package.json — keep walking up */
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function buildCompetitorProbe(): Promise<CompetitorProbe | undefined> {
  try {
    const core = (await import('@loaders.gl/core')) as {
      load: (buffer: ArrayBuffer, loader: unknown) => Promise<unknown>;
    };
    const las = (await import('@loaders.gl/las')) as { LASLoader: unknown };
    const version = competitorVersion();
    return {
      name: LOADER_COMPARISON_CONFIG.competitor.name,
      version,
      async decode(buffer: ArrayBuffer): Promise<number> {
        const data = (await core.load(buffer, las.LASLoader)) as {
          attributes?: { POSITION?: { value?: { length: number } } };
        };
        return Math.trunc((data?.attributes?.POSITION?.value?.length ?? 0) / 3);
      },
    };
  } catch {
    // The devDependency is absent (a production `--omit dev` install), so no
    // competitor can be timed. The suite records that, not a guess.
    return undefined;
  }
}

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
    expect(parseLoaderComparisonConfig(LOADER_COMPARISON_CONFIG)).toEqual(LOADER_COMPARISON_CONFIG);
  });

  test.runIf(requested.length > 0)(
    'run the requested suites and write the result tree',
    async () => {
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
      // Async: both loaders decode asynchronously, and the competitor is loaded
      // out here (see buildCompetitorProbe) and injected, so the guarded suite
      // never names the competitor package.
      const loaderComparison = wants('loaderComparison')
        ? await runLoaderComparisonSuite(parseLoaderComparisonConfig(LOADER_COMPARISON_CONFIG), {
            competitor: await buildCompetitorProbe(),
          })
        : null;

      const completedAtUtc = new Date().toISOString();
      const outcome = writeResults({
        command: `BENCHMARK_SUITES=${requested.join(',')} vitest run tests/benchmark/runSuites.test.ts`,
        startedAtUtc,
        completedAtUtc,
        reproducibility,
        scaling,
        loaderComparison,
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
      expect(loaderComparison?.summary.failures ?? []).toEqual([]);
    },
    // Generous: the 1M tier alone is seconds of real terrain work per run, and a
    // timeout here would destroy a measurement rather than report one.
    3_600_000,
  );
});
