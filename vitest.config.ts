import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import os from 'node:os';

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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_IDENTITY__: JSON.stringify(TEST_BUILD_IDENTITY),
  },
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only — Playwright specs under tests/e2e/ are excluded.
    include: ['tests/*.{test,spec}.ts'],
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
  },
});
