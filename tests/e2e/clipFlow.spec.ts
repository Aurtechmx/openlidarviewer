import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dropDenseGridPly, openToolPage, railChromeSettled } from './helpers';

/**
 * Clip flow and the result card.
 *
 * Journey 1: open a scan, Clip page → Draw clipping box → draw → Isolate this
 * box → the "Clipping on" chip shows → Keep inside/outside → an Advanced
 * numeric edit → Turn off. Journey 2: a finished measurement leaves a compact result card
 * beside the viewport with Copy, Open details and (for a Box) the clip action.
 *
 * Set OLV_FLOW_SHOTS=<dir> to also write before/after screenshots at the four
 * review viewports in light and dark (the third test).
 */
interface Api {
  setMeasureMode: (on: boolean) => void;
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
}

async function openScan(page: Page, theme?: 'light' | 'dark'): Promise<void> {
  if (theme) await page.addInitScript((t) => localStorage.setItem('olv-theme', t), theme);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
}

async function placeBox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind('box');
    api.placeMeasurementPoint({ x: 2, y: 2, z: 2 });
    api.placeMeasurementPoint({ x: -2, y: -2, z: -2 });
    if (api.getMeasurementCount() < 1) throw new Error('box not committed');
  });
}

test('Clip page: Draw clipping box → Isolate this box → chip → Keep inside/outside → Advanced edit → Turn off', async ({ page }) => {
  await openScan(page);
  await openToolPage(page, 'Clip box');
  const clip = page.locator('.olv-clip-panel');
  const chip = page.locator('.olv-clip-indicator');
  await expect(chip).toBeHidden();
  // The numeric fields are folded away until Advanced is opened.
  await expect(clip.locator('input.olv-clip-num').first()).toBeHidden();

  await clip.locator('.olv-clip-draw').click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await expect(page.locator('.olv-mkind-active')).toContainText('Box');
  await placeBox(page);

  const card = page.locator('.olv-result-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByRole('button', { name: /Isolate this box/ }).click();

  await expect(chip).toBeVisible();
  await expect(chip.locator('[role="status"]')).toHaveText('Clipping on · Showing inside box');
  await expect(card).toBeHidden();
  await expect(page.locator('.olv-ss-clip')).toContainText(/Clipped: [\d,]+ of 3,600 points/);

  await openToolPage(page, 'Clip box');
  await clip.locator('.olv-bc-pill', { hasText: 'Outside' }).click();
  await expect(chip.locator('[role="status"]')).toHaveText('Clipping on · Showing outside box');

  await clip.locator('summary', { hasText: 'Advanced' }).click();
  const xMax = clip.locator('input.olv-clip-num').nth(1);
  await expect(xMax).toBeVisible();
  await expect(xMax).toHaveValue('2.000');
  await xMax.fill('0');
  await xMax.press('Enter');
  await expect(clip.locator('[role="status"]')).toContainText(/of 3,600 points kept/);
  await expect(chip).toBeVisible();

  await chip.getByRole('button', { name: 'Turn off clipping' }).click();
  await expect(chip).toBeHidden();
  await expect(clip.locator('.olv-clip-enable input')).not.toBeChecked();
  await expect(page.locator('.olv-ss-clip')).toBeHidden();
  // The measurement is still there: the clip was an independent copy.
  await expect(page.locator('.olv-mp-row')).toHaveCount(1);
});

test('Result card: a finished measurement keeps its result beside the viewport', async ({ page }) => {
  await openScan(page);
  await openToolPage(page, 'Measure');
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureMode(true);
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 3, y: 0, z: 0 });
  });
  const card = page.locator('.olv-result-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  const listed = (await page.locator('.olv-mp-row .olv-mp-value').last().textContent())!.trim();
  await expect(card.locator('.olv-result-value')).toHaveText(listed);
  await expect(card.getByRole('button', { name: 'Copy result' })).toBeEnabled();
  // A distance has no clip action.
  await expect(card.locator('.olv-result-clip')).toBeHidden();
  await card.getByRole('button', { name: 'Open details' }).click();
  await expect(page.locator('.olv-mp-row .olv-mp-name').last()).toBeFocused();

  // A Box adds the clip action; only one card ever exists.
  await placeBox(page);
  await expect(page.locator('.olv-result-card')).toHaveCount(1);
  await expect(card.locator('.olv-result-clip')).toBeVisible();
  await card.locator('.olv-result-clip').click();
  await expect(page.locator('.olv-clip-indicator')).toBeVisible();

  // The next tool activation retires the card.
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 1, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 1, z: 0 });
  });
  await expect(card).toBeVisible();
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(card).toBeHidden();
});

const SHOTS = process.env.OLV_FLOW_SHOTS;
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x720', width: 1280, height: 720 },
  { name: '820x1180', width: 820, height: 1180 },
  { name: '390x844', width: 390, height: 844 },
];
for (const theme of ['light', 'dark'] as const) {
  for (const vp of VIEWPORTS) {
    test(`screenshots ${theme} ${vp.name}`, async ({ page }) => {
      test.skip(!SHOTS, 'set OLV_FLOW_SHOTS=<dir> to write review screenshots');
      mkdirSync(SHOTS!, { recursive: true });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openScan(page, theme);
      await page.waitForTimeout(1500);
      const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}-${theme}-${vp.name}.png` });
      await openToolPage(page, 'Clip box');
      await railChromeSettled(page);
      await page.waitForTimeout(600);
      await shot('1-clip-before');
      await page.locator('.olv-clip-draw').click();
      await placeBox(page);
      await expect(page.locator('.olv-result-card')).toBeVisible();
      await railChromeSettled(page);
      await page.waitForTimeout(600);
      await shot('2-box-result-card');
      await page.getByRole('button', { name: /Isolate this box/ }).click();
      await expect(page.locator('.olv-clip-indicator')).toBeVisible();
      await railChromeSettled(page);
      await page.waitForTimeout(800);
      await shot('3-clip-on-chip');
      // On a phone the sheet drops to its peek after a tool starts; the Advanced
      // disclosure is only reachable once the Tools page is showing again.
      const advanced = page.locator('.olv-clip-panel summary', { hasText: 'Advanced' });
      if (await advanced.isVisible()) {
        await advanced.click();
        await page.waitForTimeout(200);
        await shot('4-clip-advanced-open');
      }
    });
  }
}
