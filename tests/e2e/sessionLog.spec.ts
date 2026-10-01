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
import { dropDenseGridPly, placeProfile, showWorkspaceMode } from './helpers';

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
    await expect(cta).toHaveAccessibleName(/^Open in Profile Workbench: /);
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
    await expect(wb).toHaveAccessibleName(/^Workbench: /);
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
    await logPage.getByRole('button', { name: 'Export JSON', exact: true }).click();
    expect((await json).suggestedFilename()).toMatch(/^session-log-\d{8}-\d{4}\.json$/);
    const csv = page.waitForEvent('download');
    await logPage.getByRole('button', { name: 'Export CSV', exact: true }).click();
    expect((await csv).suggestedFilename()).toMatch(/\.csv$/);
    // Each export is itself a line in the log.
    await expect(logPage.locator('.olv-sl-text', { hasText: /^Exported session-log-/ })).toHaveCount(2);
  });
});

const CANDIDATE_POINTS = [
  { x: 0.5, y: 0.5 }, { x: 0.46, y: 0.46 }, { x: 0.54, y: 0.54 }, { x: 0.5, y: 0.42 }, { x: 0.5, y: 0.58 },
];

/** Click the canvas near its centre until the annotation editor opens, then save `title`. */
async function placeAnnotation(page: Page, title: string, offset: number): Promise<void> {
  const box = await page.locator('canvas').first().boundingBox();
  if (!box) throw new Error('scene canvas has no bounding box');
  const editor = page.locator('.olv-anno-editor');
  let opened = false;
  for (let i = 0; i < CANDIDATE_POINTS.length && !opened; i++) {
    const p = CANDIDATE_POINTS[(i + offset) % CANDIDATE_POINTS.length]!;
    await page.mouse.click(box.x + box.width * p.x, box.y + box.height * p.y);
    opened = await editor.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true, () => false);
  }
  if (!opened) throw new Error('no canvas point opened the annotation editor');
  await page.locator('.olv-anno-editor-title').fill(title);
  await page.locator('.olv-anno-editor-save').click();
  await expect(editor).toBeHidden();
}

test.describe('session log sources', () => {
  test('filtering the annotation list adds no create or delete lines', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.locator('.olv-tool', { hasText: 'Annotate' }).click();
    await showWorkspaceMode(page, 'work');
    await placeAnnotation(page, 'First note', 0);
    await placeAnnotation(page, 'Second note', 1);
    const search = page.locator('.olv-ap-search');
    await search.fill('First');
    await expect(page.locator('.olv-anno-panel .olv-ap-row')).toHaveCount(1);
    await search.fill('');
    await expect(page.locator('.olv-anno-panel .olv-ap-row')).toHaveCount(2);
    await page.keyboard.press('Escape');

    await openFromPalette(page, 'actions');
    const texts = page.locator('.olv-session-log .olv-sl-text');
    await expect(texts.filter({ hasText: /^Annotation created: / })).toHaveCount(2);
    await expect(texts.filter({ hasText: /^Annotation deleted: / })).toHaveCount(0);
  });

  test('with no scan open, the palette shows the log of a failed open in a dialog', async ({ page }) => {
    await page.goto('/?test=1');
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], 'broken #1.laz'));
      return d;
    });
    await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
    await expect(page.locator('body > .olv-visually-hidden[role="alert"]')).not.toHaveText('', { timeout: 20_000 });
    await expect(page.locator('.olv-left-panels')).toBeAttached({ timeout: 20_000 });

    await openFromPalette(page, 'actions');
    const dialog = page.getByRole('dialog', { name: 'Session log' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.olv-sl-row.is-error')).not.toHaveCount(0);
    await shot(page, 'session-log-no-scan');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
