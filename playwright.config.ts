import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the production build served by `vite preview`.
 * Run locally with `npm run test:e2e` (install browsers first with
 * `npx playwright install --with-deps chromium`).
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    // Pre-seed localStorage so the onboarding tour overlay (which
    // auto-launches on first session per browser and intercepts
    // pointer events) is treated as already-completed for every
    // test. The key string mirrors `STORAGE_KEY` in
    // src/ui/onboarding/tourSteps.ts; if that constant changes,
    // update this string too. Without this seeding the first click
    // in any spec hits the tour backdrop instead of the target.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:4173',
          localStorage: [{ name: 'olv:tour:v1:completed', value: '1' }],
        },
      ],
    },
  },
  // Two projects split the suite by whether a spec's result depends on the
  // runner's GPU. `deterministic` is the BLOCKING gate: DOM, layout, routing,
  // export and streaming-logic flows that must pass identically everywhere.
  // `gpu` is advisory: specs whose outcome varies with the WebGPU adapter a CI
  // runner happens to expose. Tag a spec into the advisory set by putting
  // `@gpu` in its describe/test title — untagged specs block, which is the safe
  // default (a new spec gates until proven GPU-variable).
  projects: [
    { name: 'deterministic', use: { ...devices['Desktop Chrome'] }, grepInvert: /@gpu/ },
    { name: 'gpu', use: { ...devices['Desktop Chrome'] }, grep: /@gpu/ },
  ],
  webServer: {
    // SMOKE_LIVE boots the OBFUSCATED live artifact (the build users actually
    // get) so the smoke gate catches live-only breakage — scrambled
    // dynamic-import / worker-URL string literals, chunk-isolation regressions —
    // that the plain build can never surface. Default stays the plain build for
    // the fast e2e loop.
    command: process.env.SMOKE_LIVE
      ? 'npm run build:live && npm run preview'
      : 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
