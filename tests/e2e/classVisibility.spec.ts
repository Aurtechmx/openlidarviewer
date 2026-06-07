import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas, dropTinyPly } from './helpers';

/**
 * Class-visibility (v0.4.2) — the honesty loop.
 *
 * The classification legend lists one row per ASPRS class present in the
 * loaded scan (swatch · name · "shown" count · Solo · checkbox), with a
 * "Show all" reset and a persistent banner that appears only while a filter
 * is active. Hiding a class re-runs the scan report so every class-dependent
 * metric is recomputed under the visible subset and stamped with its scope;
 * "Show all" clears the filter, the banner, and the stamps.
 *
 * Fixture choice:
 *   `tiny.las` is the only bundled cloud that carries a classification
 *   channel (codes 1, 2, 3, 5, 6 — five present classes; see
 *   scripts/make-fixtures.py and tests/fixtures/FIXTURES.md). It is loaded
 *   via the same DataTransfer drop the other specs use, exercising the real
 *   load → decode → legend path. `tiny.ply` carries no classification, so it
 *   drives the empty-state assertion. No large/external classified fixture is
 *   required, so this spec runs on CI without a skip guard for the core loop.
 *
 *   The Inspector scan report lives in a side panel that may be collapsed in
 *   a GPU-less or narrow context; the scope-stamp assertions are therefore
 *   guarded — they assert the stamp DOM only when the report has rendered
 *   rows, and never fail the run if the report panel is not on screen. The
 *   legend banner is the load-bearing, always-visible honesty signal and is
 *   asserted unconditionally.
 *
 * Runs against the production preview (see playwright.config.ts); the load
 * path needs a real WebGL/WebGPU context and won't run in a GPU-less sandbox.
 */

/** Selectors, centralised so a DOM rename is a one-line fix. */
const LEGEND = '.olv-class-panel';
const ROW = '.olv-cl-row';
const CHECK = '.olv-cl-check';
const BANNER = '.olv-cl-banner';
const SHOW_ALL = '.olv-cl-showall';
const EMPTY = '.olv-cl-empty';
const SCOPE_STAMP = '.olv-report-scope';

/** Load the classified `tiny.las` and wait for the legend to populate. */
async function loadClassifiedScan(page: Page): Promise<void> {
  await page.goto('/');
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // The legend is revealed once the class buffer is counted; the panel is
  // visible (not `.olv-hidden`) and shows at least one class row.
  await expect(page.locator(LEGEND)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

test('a classified scan shows the class legend with more than one class row', async ({
  page,
}) => {
  await loadClassifiedScan(page);

  // tiny.las carries five present ASPRS classes (1, 2, 3, 5, 6), so the
  // legend must render multiple rows — the precondition for filtering.
  const rows = page.locator(`${LEGEND} ${ROW}`);
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(1);

  // No filter is active on a fresh load, so the banner stays hidden and the
  // "Show all" reset is disabled (nothing to reset).
  await expect(page.locator(`${LEGEND} ${BANNER}`)).toBeHidden();
  await expect(page.locator(`${LEGEND} ${SHOW_ALL}`)).toBeDisabled();
});

test('hiding a class raises the filtered banner (and scope-stamps the report when visible)', async ({
  page,
}) => {
  await loadClassifiedScan(page);

  const rows = page.locator(`${LEGEND} ${ROW}`);
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);

  // Uncheck the first class — the same change a real user makes by clicking
  // the row's visibility checkbox.
  const firstCheck = rows.first().locator(CHECK);
  await expect(firstCheck).toBeChecked();
  await firstCheck.uncheck();

  // The persistent banner appears and reports the surviving-of-total count.
  const banner = page.locator(`${LEGEND} ${BANNER}`);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(
    new RegExp(`Filtered — showing ${total - 1} of ${total} classes`),
  );

  // "Show all" becomes actionable once a filter is active.
  await expect(page.locator(`${LEGEND} ${SHOW_ALL}`)).toBeEnabled();

  // Scope stamp — the scan report re-runs under the visible subset and stamps
  // each class-dependent readout. The report lives in a side panel that may be
  // collapsed / off-screen in this context (GPU-less, narrow, or a panel that
  // opened over it), so gate on the report row being actually VISIBLE — not
  // merely present in the DOM. When the report is on screen the stamp must be
  // visible and carry its scope separator; when it's collapsed the rows exist
  // but are hidden, and we skip rather than fail. The legend banner above is
  // the unconditional, always-visible honesty signal.
  const reportRow = page.locator('.olv-report .olv-report-row').first();
  if (await reportRow.isVisible().catch(() => false)) {
    const scope = page.locator(SCOPE_STAMP).first();
    await expect(scope).toBeVisible();
    await expect(scope).toContainText('·');
  }
});

test('"Show all" clears the filter, the banner, and any scope stamps', async ({
  page,
}) => {
  await loadClassifiedScan(page);

  const rows = page.locator(`${LEGEND} ${ROW}`);
  expect(await rows.count()).toBeGreaterThan(1);

  // Enter a filtered state by hiding the first class.
  await rows.first().locator(CHECK).uncheck();
  const banner = page.locator(`${LEGEND} ${BANNER}`);
  await expect(banner).toBeVisible();

  // Capture whether the report exposed any scope stamp while filtered, so the
  // post-reset assertion only checks what was actually present.
  const hadStamp = (await page.locator(SCOPE_STAMP).count()) > 0;

  // Reset — every class visible again.
  await page.locator(`${LEGEND} ${SHOW_ALL}`).click();

  // The banner disappears and the reset disables itself (nothing to reset).
  await expect(banner).toBeHidden();
  await expect(page.locator(`${LEGEND} ${SHOW_ALL}`)).toBeDisabled();
  // Every checkbox is checked again.
  const checks = page.locator(`${LEGEND} ${CHECK}`);
  const n = await checks.count();
  for (let i = 0; i < n; i++) {
    await expect(checks.nth(i)).toBeChecked();
  }

  // If a scope stamp showed while filtered, it must clear once unfiltered —
  // the full-cloud readouts carry no scope provenance.
  if (hadStamp) {
    await expect(page.locator(SCOPE_STAMP)).toHaveCount(0);
  }
});

test('a class-less scan shows the legend empty state', async ({ page }) => {
  await page.goto('/');
  // tiny.ply carries RGB only, no classification channel.
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // The panel is still revealed, but in its disabled empty state: no class
  // rows, the explanatory empty message, and a disabled "Show all".
  await expect(page.locator(LEGEND)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`${LEGEND} ${EMPTY}`)).toBeVisible();
  await expect(page.locator(`${LEGEND} ${ROW}`)).toHaveCount(0);
  await expect(page.locator(`${LEGEND} ${SHOW_ALL}`)).toBeDisabled();
});
