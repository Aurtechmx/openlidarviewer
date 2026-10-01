/**
 * sessionLog.spec.ts
 *
 * Two requests from beta testing:
 *
 *   - a finished profile offers "Open in Profile Workbench" beside its result,
 *     reachable by keyboard, and the Results shelf row for the profile offers
 *     the same step;
 *   - the palette opens a Session log page under Data that lists what was done
 *     in this tab, with a location bar crumb, Back and Escape.
 *
 * Screenshots go to `OLV_SHOT_DIR` when it is set.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { placeProfile } from './helpers';

const SHOT_DIR = process.env.OLV_SHOT_DIR;

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  if (!SHOT_DIR) return;
  if (target) await target.screenshot({ path: `${SHOT_DIR}/${name}.png` });
  else await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

async function openFromPalette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const input = page.locator('.olv-palette-input');
  await expect(input).toBeFocused();
  await input.fill(query);
  const first = page.locator('.olv-palette-row .olv-palette-row-title').first();
  await expect(first).toHaveText('Session log');
  await page.keyboard.press('Enter');
  await expect(page.locator('.olv-palette')).toBeHidden();
}

test.describe('profile workbench button', () => {
  test('a finished profile shows one primary "Open in Profile Workbench" that opens the dock', async ({ page }) => {
    await placeProfile(page);
    const cta = page.locator('.olv-mp-open-workbench');
    await expect(cta).toHaveCount(1);
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText('Open in Profile Workbench');
    await expect(cta).toHaveClass(/olv-primary-action/);
    const box = await cta.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    // One primary action in the panel for this state.
    await expect(page.locator('.olv-measure-panel .olv-primary-action:visible')).toHaveCount(1);
    await shot(page, 'workbench-button', page.locator('.olv-measure-panel'));

    await cta.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 10_000 });
    await shot(page, 'workbench-open');
  });

  test('the profile row in the Results shelf opens the Profile Workbench', async ({ page }) => {
    await placeProfile(page);
    await page.locator('.olv-results-toggle').click();
    const wb = page.locator('.olv-results-row[data-result-type="measurement"] .olv-results-workbench');
    await expect(wb).toHaveCount(1);
    await expect(wb).toHaveAccessibleName(/Open .* in the Profile Workbench/);
    await wb.click();
    await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('session log', () => {
  test('the palette finds it by "/actions" and it lists the scan and the measurement', async ({ page }) => {
    await placeProfile(page);
    await openFromPalette(page, '/actions');

    const logPage = page.locator('.olv-session-log');
    await expect(logPage).toBeVisible();
    await expect(page.locator('#olv-ws-mode-data .olv-ws-task-title')).toHaveText('Session log');
    await expect(page.locator('.olv-topbar .olv-loc')).toContainText('Session log');

    const texts = logPage.locator('.olv-sl-text');
    await expect(texts.filter({ hasText: /^Opened / })).toHaveCount(1);
    await expect(texts.filter({ hasText: /^Measurement created: / })).toHaveCount(1);
    await expect(texts.filter({ hasText: /^Location: / })).toHaveCount(0);
    // Newest first by default: the last thing done heads the table.
    const rows = logPage.locator('tbody .olv-sl-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(2);
    // The scan each entry applied to is named on the row.
    await expect(logPage.locator('.olv-sl-meta').first()).toContainText('.ply');
    await shot(page, 'session-log', page.locator('#olv-ws-mode-data'));

    // Escape returns to the Data home. The Measure tool is still on from the
    // placement, and the first Escape turns it off, as it does on every page.
    await page.locator('.olv-sl-order').focus();
    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-dock [data-action="tool.measure"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(logPage).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(logPage).toBeHidden();
    await expect(page.locator('#olv-ws-mode-data .olv-ws-task')).toBeHidden();

    // Opened again, its Back returns to Data too.
    await openFromPalette(page, 'actions');
    await expect(logPage).toBeVisible();
    await page.locator('#olv-ws-mode-data .olv-ws-back').click();
    await expect(logPage).toBeHidden();
  });

  test('a palette command run is logged, and the export buttons download JSON and CSV', async ({ page }) => {
    await placeProfile(page);
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('Frame all');
    await page.keyboard.press('Enter');
    await openFromPalette(page, 'session log');
    const logPage = page.locator('.olv-session-log');
    await expect(logPage.locator('.olv-sl-text', { hasText: /^Frame all$/ })).toHaveCount(1);

    const json = page.waitForEvent('download');
    await logPage.getByRole('button', { name: 'Export the session log as JSON' }).click();
    expect((await json).suggestedFilename()).toMatch(/^session-log-\d{8}-\d{4}\.json$/);
    const csv = page.waitForEvent('download');
    await logPage.getByRole('button', { name: 'Export the session log as CSV' }).click();
    expect((await csv).suggestedFilename()).toMatch(/\.csv$/);
    // Each export is itself a line in the log.
    await expect(logPage.locator('.olv-sl-text', { hasText: /^Exported session-log-/ })).toHaveCount(2);
  });
});
