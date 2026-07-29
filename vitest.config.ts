import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { forcedGcRequested } from './benchmarks/runner/gcMode';

// Mirror the `__APP_VERSION__` define the Vite build stamps in, so test files
// (and modules they import — like `BaseExportMode.ts`) can read the version
// constant the same way the runtime build does.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

// A FIXED build identity for tests: the real Vite build resolves this from git +
// wall clock (see resolveBuildIdentity in vite.config.ts), but tests need it
// deterministic so provenance assertions don't chase a moving timestamp/commit.
const TEST_BUILD_IDENTITY = {
  version: pkg.version,
  commit: 'testtest',
  dirty: false,
  builtAt: '1970-01-01T00:00:00.000Z',
  node: process.version,
  channel: 'test',
};

// Resolve the worker cap once, up front. `availableParallelism()` (Node 18.14+)
// reflects cgroup/affinity limits better than `cpus().length`; fall back to the
// latter on older runtimes. See the `maxWorkers` comment below for why we clamp
// to an absolute 8 rather than trusting a bare percentage.
const cores = os.availableParallelism ? os.availableParallelism() : os.cpus().length;
const maxWorkers = Math.max(1, Math.min(8, Math.floor(cores * 0.75)));

/**
 * `--expose-gc` for the benchmark suites, on request only.
 *
 * WHY IT HAS TO BE SET HERE. Tests do not run in the process that reads this
 * file; they run in pool workers, and a node flag on the vitest command line
 * never reaches them. `poolOptions.forks.execArgv` is the argument vector those
 * workers are actually launched with, so this is the only place the flag can be
 * added such that `global.gc` exists where a pipeline run can call it.
 *
 * WHY THE ENV VAR AND NOT A CONSTANT. The scaling ladder spawns a child
 * `vitest run` per tier (see `scalingIsolated.ts`), which re-reads this file in
 * a fresh process and inherits nothing but the environment. Keying off an env
 * var is what makes the parent, the tier children and their workers agree; a
 * value hard-coded per invocation would apply to the parent alone and the tiers
 * would silently be measured in the other mode.
 *
 * Off by default, deliberately. Forced GC is never a pass condition — the
 * suites record whether it was available and carry on without it, so a default
 * checkout keeps working and a GC-controlled run is an explicit, labelled act.
 */
const benchmarkExecArgv = forcedGcRequested() ? ['--expose-gc'] : [];

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_IDENTITY__: JSON.stringify(TEST_BUILD_IDENTITY),
  },
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only — Playwright specs under tests/e2e/ are excluded. The
    // benchmark-framework suites live one level down, so they are listed
    // explicitly rather than by a `tests/**` glob that would sweep e2e back in.
    include: ['tests/*.{test,spec}.ts', 'tests/benchmark/*.{test,spec}.ts'],
    // Headroom over the 5 s default so the heavier DOM-building / LAS-decoding
    // suites don't time out (and flake) under parallel load on a busy machine —
    // 15 s is still unambiguously "broken" if a unit test ever hits it.
    testTimeout: 15_000,
    // Cap parallelism so a WASM/LAZ decoder or a heavy DTM build isn't starved
    // of CPU under full-bucket parallel load on a busy CI runner — the root cause
    // of the loadLas / terrain-density timeout flakes. We take 75 % of cores but
    // never more than 8 workers: a relative percentage alone lets a many-core,
    // low-RAM runner (e.g. ~56 CPUs / ~4 GB) spawn ~40 fork workers and exhaust
    // memory (EPIPE / hang at pool shutdown) even when every assertion passes, so
    // the absolute cap of 8 keeps memory bounded on those runners while a normal
    // dev box still gets full 75 % speed. The per-bucket runner
    // (scripts/test-bucket.mjs) tightens this further for the slow bucket.
    // (Vitest 4 dropped the top-level `minWorkers` option; a floor of 1 is
    // already guaranteed by the Math.max(1, …) clamp on `maxWorkers` above.)
    maxWorkers,
    // The default pool, stated rather than assumed: `--expose-gc` is not
    // accepted on a worker_thread's execArgv at all, so the flag below only
    // works on a child-process pool. If the pool ever moves to threads the flag
    // stops arriving — `tests/benchmark/forcedGc.test.ts` fails loudly at that
    // point rather than letting a mislabelled result tree get published.
    pool: 'forks',
    // Vitest 4 flattened the old `poolOptions.forks.execArgv` to this top-level
    // option. Written with the flat name because the nested one is not merely
    // deprecated, it is IGNORED: the run stays green and the workers simply
    // never get the flag.
    execArgv: benchmarkExecArgv,
    /**
     * Coverage is scoped to the PURE modules — the numeric, geometric and
     * model code whose behaviour a unit test can actually pin. Deliberately
     * excluded: the render layer (WebGPU/three, exercised by the e2e suite),
     * the UI/panel layer (DOM wiring), workers, and the two orchestration
     * monoliths (main.ts / Viewer.ts) whose decomposition is in progress —
     * a repo-wide percentage there would be a number nobody acts on.
     * Thresholds are a ratchet: raise them as the decomposition lands, never
     * lower them to make a build pass.
     */
    coverage: {
      provider: 'v8',
      // lcov is for Codecov; the other two are read by the gate and by a
      // human respectively. Adding a reporter does not change what is
      // measured, only how it is written out.
      reporter: ['text-summary', 'json-summary', 'lcov'],
      include: [
        'src/process/**/*.ts',
        'src/terrain/**/*.ts',
        'src/render/measure/**/*.ts',
        'src/io/crs.ts',
        'src/model/**/*.ts',
        'src/app/**/*.ts',
        'src/analysis/**/*.ts',
        'src/export/measurementExport.ts',
        'src/report/**/*.ts',
      ],
      exclude: ['**/*.d.ts', '**/worker/**', '**/*.generated.ts'],
      // Set just under the measured baseline (lines 90.57 / statements 89.19 /
      // functions 87.75 / branches 82.73), so a real regression fails the gate
      // while an incidental point of drift does not. Ratchet these UP as the
      // decomposition adds tested modules; never down to make a build pass.
      thresholds: { lines: 89, functions: 86, statements: 88, branches: 81 },
    },
  },
});
