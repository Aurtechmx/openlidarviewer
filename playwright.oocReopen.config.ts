import { defineConfig, devices } from '@playwright/test';

/**
 * The OOC reopen benchmark runs against the Vite DEV server, not the preview
 * build the main config uses: the harness does an in-page dynamic import of the
 * real `/src` build modules, which only the dev server serves as modules. It is
 * a single Chromium project — the measurement is OPFS read latency, not a
 * cross-browser behaviour — and is gated inside the spec by OOC_REOPEN_BENCH so
 * a normal run is a no-op.
 *
 * Run with: OOC_REOPEN_BENCH=1 npx playwright test --config playwright.oocReopen.config.ts
 */
export default defineConfig({
  testDir: './tests/browser-bench',
  testMatch: /.*\.bench\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 600_000,
  use: {
    baseURL: 'http://localhost:5173',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'ooc-reopen', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
