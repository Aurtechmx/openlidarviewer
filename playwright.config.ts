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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
