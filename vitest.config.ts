import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Unit tests only — Playwright specs under tests/e2e/ are excluded.
    include: ['tests/*.{test,spec}.ts'],
  },
});
