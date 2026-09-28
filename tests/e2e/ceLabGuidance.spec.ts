/**
 * Lab guidance on the lab pages (spec CE-1, CE-LAB-06 to CE-LAB-10).
 *
 * Each lab page opens with its purpose line and 3 to 5 numbered stages, one
 * marked current. Before the run control it lists what it needs, met or
 * missing, and a missing ground surface offers the one action that fills it.
 * While something is missing the run control is off and says why in text.
 * After a run a "How to read this" block sits beside the result.
 * Deterministic project.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dropDenseGridPly, dropTinyPtx, showWorkspaceMode } from './helpers';

const labPage = (page: Page, id: string): Locator => page.locator(`.olv-analyse-page[data-page="${id}"]`);

async function openScan(page: Page, drop = dropDenseGridPly): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?test=1');
  await drop(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
}

async function openLab(page: Page, id: string): Promise<Locator> {
  await showWorkspaceMode(page, 'analyse');
  await page.locator(`.olv-ah-row[data-analysis="${id}"] .olv-ah-open`).click();
  const lab = labPage(page, id);
  await expect(lab).toBeVisible({ timeout: 20_000 });
  return lab;
}

async function expectHeader(lab: Locator, purpose: RegExp): Promise<void> {
  await expect(lab.locator('.olv-lab-purpose')).toHaveText(purpose);
  const stages = lab.locator('.olv-lab-stage');
  const n = await stages.count();
  expect(n).toBeGreaterThanOrEqual(3);
  expect(n).toBeLessThanOrEqual(5);
  await expect(stages.first()).toHaveText(/^1\. /);
  await expect(lab.locator('.olv-lab-stage[aria-current="step"]')).toHaveCount(1);
}

test.describe('lab guidance on the lab pages', () => {
  test.slow();

  test('Flow Pulse: missing ground names its fix; after the run, How to read this', async ({ page }) => {
    test.setTimeout(180_000);
    await openScan(page);
    const lab = await openLab(page, 'flow-pulse');
    await expectHeader(lab, /Counts cells, not rainfall\.$/);
    await expect(lab.locator('.olv-lab-ready[data-state="missing"]')).toContainText('Ground surface (terrain run)');
    // The empty state names the one action that fills it, and offers it.
    await expect(lab.locator('.olv-lab-needs-text')).toContainText('Run terrain analysis');
    const fix = lab.locator('.olv-lab-fix', { hasText: 'Run terrain analysis' });
    await expect(fix).toBeVisible();
    await fix.click();
    const back = page.locator('.olv-at-back', { hasText: 'Back to Flow Pulse' });
    await expect(back).toBeVisible({ timeout: 90_000 });
    await back.click();
    await expect(lab.locator('.olv-lab-ready[data-state="met"]')).toContainText('Ground surface (terrain run)');
    await expect(lab.locator('.olv-story-card')).toBeVisible({ timeout: 30_000 });
    const read = lab.locator('.olv-lab-read');
    await expect(read.locator('.olv-lab-read-title')).toHaveText('How to read this');
    const lines = await read.locator('.olv-lab-read-line').count();
    expect(lines).toBeGreaterThanOrEqual(2);
    expect(lines).toBeLessThanOrEqual(4);
  });

  test('Terrain Access: while units are unknown the run control is off and says why', async ({ page }) => {
    test.setTimeout(180_000);
    await openScan(page);
    let lab = await openLab(page, 'terrain-access');
    await expectHeader(lab, /Not a safety guarantee\.$/);
    await lab.locator('.olv-lab-fix', { hasText: 'Run terrain analysis' }).click();
    const back = page.locator('.olv-at-back', { hasText: 'Back to Terrain Access' });
    await expect(back).toBeVisible({ timeout: 90_000 });
    await back.click();
    lab = labPage(page, 'terrain-access');
    await expect(lab.locator('.olv-lab-ready[data-state="missing"]')).toContainText('Units known');
    await expect(lab.locator('.olv-ta-form-submit')).toBeDisabled();
    // The reason is text beside the control, not a tooltip.
    await expect(lab.locator('.olv-ta-form-blocked')).toBeVisible();
    await expect(lab.locator('.olv-ta-form-blocked')).toContainText('grades and distances need known units');
  });

  test('Observatory: purpose, stages, and How to read this after the run', async ({ page }) => {
    test.setTimeout(180_000);
    await openScan(page, dropTinyPtx);
    const lab = await openLab(page, 'observatory');
    await expectHeader(lab, /where another setup would help\.$/);
    await expect(lab.locator('.olv-observatory-state-counts')).toContainText(/SURFACE: \d+/, { timeout: 30_000 });
    await expect(lab.locator('.olv-lab-read-title').first()).toHaveText('How to read this');
  });
});
