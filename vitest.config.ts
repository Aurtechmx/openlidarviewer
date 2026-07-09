import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

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
  },
});
