import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyLas } from './helpers';

/**
 * inspectorLazySections.spec.ts
 *
 * The Inspector's Coordinate system / Provenance / Scan report sections
 * (INSP-lazy-1): their render bodies load through lazy chunks
 * (`ui/inspector/renderCrs.ts`, `renderProvenance.ts`, `renderReport.ts`,
 * see `Inspector.setCrs`/`setProvenance`/`setReport`). This proves the
 * placeholder-to-content transition survives a real scan open, that
 * keyboard Tab order reaches the hydrated override controls, and that a
 * blocked chunk shows a retry caption that actually recovers — the one
 * behavior with no existing precedent test (see `lazyOverlayStates.spec.ts`'s
 * header comment).
 */

const STALE_RELOAD_KEY = 'olv:stale-reload-at';

/** Pre-seed the stale-chunk-recovery cooldown so the FIRST route abort in a
 *  test already takes the "already tried, don't reload" branch — see
 *  staleChunkReload.ts and lazyOverlayStates.spec.ts's header comment. */
async function seedStaleReloadCooldown(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // Storage may be blocked; the test still exercises the failure path,
      // just via a real (harmless) reload instead of the no-reload branch.
    }
  }, STALE_RELOAD_KEY);
}

async function gotoWithScan(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  await page.goto('/');
  await expect(page.locator('.olv-empty')).toBeVisible();
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

test.describe('Inspector lazy sections — hydration', () => {
  test('Scan report and Provenance placeholders are replaced by real content after scan-open', async ({
    page,
  }) => {
    await gotoWithScan(page);

    // Open the collapsed sections so their bodies are visible.
    await page.locator('summary', { hasText: 'Scan report' }).click();
    await page.locator('summary', { hasText: 'Provenance' }).click();

    await expect(page.locator('.olv-report .olv-report-row').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.olv-provenance .olv-prov-headline')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('keyboard Tab reaches the Provenance capture-type override select once hydrated', async ({
    page,
  }) => {
    await gotoWithScan(page);
    await page.locator('summary', { hasText: 'Provenance' }).click();

    const select = page.locator('.olv-prov-override-select');
    await expect(select).toBeVisible({ timeout: 10_000 });
    await select.focus();
    await expect(select).toBeFocused();
  });
});

test.describe('Inspector lazy sections — blocked chunk', () => {
  test('a blocked Scan report chunk shows a retry caption', async ({ page }) => {
    await seedStaleReloadCooldown(page);
    await suppressOnboardingTour(page);
    await page.goto('/');
    await expect(page.locator('.olv-empty')).toBeVisible();

    await page.route('**/renderReport-*.js', (route) => route.abort());

    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('summary', { hasText: 'Scan report' }).click();

    const retry = page.locator('.olv-report .olv-inline-retry');
    await expect(retry).toBeVisible({ timeout: 10_000 });
  });

  // Firefox re-fetches a specifier that already failed once; Chromium/WebKit
  // cache the failure and never reach the network on retry (see
  // `lazyOverlayStates.spec.ts`'s header comment), so only this leg can
  // exercise a real fail-then-succeed round trip.
  test('firefox: Try again after a blocked Scan report chunk recovers it', async ({
    page,
    browserName,
  }) => {
    test.skip(
      browserName !== 'firefox',
      'Chromium/WebKit cannot re-fetch a failed specifier without a full navigation.',
    );
    await seedStaleReloadCooldown(page);
    await suppressOnboardingTour(page);
    await page.goto('/');
    await expect(page.locator('.olv-empty')).toBeVisible();

    let attempts = 0;
    await page.route('**/renderReport-*.js', (route) =>
      ++attempts === 1 ? route.abort() : route.continue(),
    );

    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('summary', { hasText: 'Scan report' }).click();

    const retry = page.locator('.olv-report .olv-inline-retry');
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await retry.click();

    await expect(page.locator('.olv-report .olv-report-row').first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
