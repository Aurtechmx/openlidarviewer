import { test, expect, type Page } from '@playwright/test';
import { dropTinyPly, dropTinyLas } from './helpers';

/**
 * Classify (derive) — unsupervised classification of an UNclassified scan.
 *
 * The pure classifier + the worker/fallback bridge are covered by unit tests
 * (deriveClassification.test.ts, deriveClassificationAsync.test.ts). This spec
 * exercises the real user surface: a class-less cloud, the command-palette
 * "Classify (derive)" action, and the result landing in the legend as DERIVED
 * (honest caption) with filterable class rows.
 *
 * Fixture choice:
 *   `tiny.ply` carries RGB only, no classification — so it drives both the
 *   pre-classify empty state and the derive path. `tiny.las` already carries a
 *   classification, so it drives the "already classified → no-op" guard.
 *
 * Runs against the production preview (see playwright.config.ts); the load +
 * worker path needs a real WebGL/WebGPU context and won't run in a GPU-less
 * sandbox.
 */

const LEGEND = '.olv-class-panel';
const ROW = '.olv-cl-row';
const CHECK = '.olv-cl-check';
const BANNER = '.olv-cl-banner';
const EMPTY = '.olv-cl-empty';
const DERIVED = '.olv-cl-derived';

/** Open the palette and fire the Classify action. */
async function runClassify(page: Page): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill('Classify');
  // The action row must exist before we fire it.
  await expect(
    page.locator('.olv-palette-row', { hasText: 'Classify (derive)' }),
  ).toBeVisible();
  await page.locator('.olv-palette-input').press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

test('deriving a classification for a class-less scan fills the legend, flagged DERIVED', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // Before: the legend is in its empty (no-classification) state.
  await expect(page.locator(LEGEND)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${LEGEND} ${EMPTY}`)).toBeVisible();
  await expect(page.locator(`${LEGEND} ${ROW}`)).toHaveCount(0);
  await expect(page.locator(`${LEGEND} ${DERIVED}`)).toBeHidden();

  await runClassify(page);

  // After: the derived caption is shown (honest provenance) and the legend now
  // lists at least one derived class row. Generous timeout — the derive runs in
  // a worker (or the main-thread fallback) before the legend repopulates.
  await expect(page.locator(`${LEGEND} ${DERIVED}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${LEGEND} ${DERIVED}`)).toContainText(/not survey-grade/i);
  const rows = page.locator(`${LEGEND} ${ROW}`);
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  expect(await rows.count()).toBeGreaterThan(0);
  // The empty-state message is gone once classes exist.
  await expect(page.locator(`${LEGEND} ${EMPTY}`)).toBeHidden();
});

test('a derived class is filterable from the legend (GPU mask wired)', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(LEGEND)).toBeVisible({ timeout: 20_000 });

  await runClassify(page);
  await expect(page.locator(`${LEGEND} ${DERIVED}`)).toBeVisible({ timeout: 20_000 });

  const rows = page.locator(`${LEGEND} ${ROW}`);
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });

  // Hiding a derived class must raise the filtered banner — proof the derived
  // codes drive the GPU class-visibility mask, not just the colours.
  const firstCheck = rows.first().locator(CHECK);
  await expect(firstCheck).toBeChecked();
  await firstCheck.uncheck();
  await expect(page.locator(`${LEGEND} ${BANNER}`)).toBeVisible();
});

test('Classify is a no-op on a scan that already carries a classification', async ({
  page,
}) => {
  await page.goto('/');
  // tiny.las already has ASPRS classes — the derive guard must not overwrite it
  // and must not stamp the legend as derived.
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator(LEGEND)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${LEGEND} ${ROW}`).first()).toBeVisible({ timeout: 20_000 });

  await runClassify(page);

  // The file's classification stays authoritative: no derived caption appears.
  await expect(page.locator(`${LEGEND} ${DERIVED}`)).toBeHidden();
});
