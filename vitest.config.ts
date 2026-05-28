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
  },
});
