import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// Mirror the `__APP_VERSION__` define the Vite build stamps in, so test files
// (and modules they import — like `BaseExportMode.ts`) can read the version
// constant the same way the runtime build does.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
