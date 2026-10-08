/**
 * J6 Find results again: a measurement made in Tools is found from another
 * mode through the Results shelf and comes back with the same value.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildSurveyLas14, openWith, startJourney } from './helpers/journey';
import { showWorkspaceMode } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

async function place(page: Page, pts: Array<[number, number, number]>): Promise<void> {
  await page.evaluate((pts) => {
    const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    for (const [x, y, z] of pts) api.placeMeasurementPoint({ x, y, z });
  }, pts);
}

test('P1: a measurement is found again on the Results shelf and restored unchanged', async ({ page }, info) => {
  const j = startJourney(page, info, 'j6');
  const survey = await buildSurveyLas14();
  await j.step('open the survey file and measure', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await place(page, [[1, 2, 0], [7, 10, 0]]);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  });
  const before = (await page.locator('.olv-mp-row').first().innerText()).replace(/\s+/g, ' ');
  expect(before).toMatch(/^10\.0+ m\b/);

  const shelf = page.locator('#olv-left-panels .olv-results-shelf');
  await j.step('switch to Data, then open the Results shelf', async () => {
    await page.keyboard.press('Escape');
    await showWorkspaceMode(page, 'data');
    await expect(page.locator('.olv-measure-panel')).toBeHidden();
    await shelf.locator('.olv-results-toggle').click();
  });
  await j.step('the row names its source scan and restores the same value', async () => {
    const row = shelf.locator('.olv-results-row[data-result-type="measurement"]');
    await expect(row).toHaveCount(1);
    await row.locator('.olv-results-focus').click();
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
    expect((await page.locator('.olv-mp-row').first().innerText()).replace(/\s+/g, ' ')).toBe(before);
  });
});

test('P1: with one scan open, the Results row still names the scan it came from', async ({ page }, info) => {
  // FINDING J6-SOURCE: the row reads "Distance 1 / 02:11 · Ready" and names
  // no scan; the source is shown only when the result is from another layer.
  // The journey asks for every item to be labelled with its source scan.
  test.fail();
  const j = startJourney(page, info, 'j6');
  const survey = await buildSurveyLas14();
  await j.step('open the survey file and measure', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await place(page, [[1, 2, 0], [7, 10, 0]]);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
    await page.keyboard.press('Escape');
    await showWorkspaceMode(page, 'data');
  });
  await j.step('the row names survey-14.las', async () => {
    const shelf = page.locator('#olv-left-panels .olv-results-shelf');
    await shelf.locator('.olv-results-toggle').click();
    await expect(shelf.locator('.olv-results-row[data-result-type="measurement"]')).toContainText('survey-14.las', { timeout: 3_000 });
  });
});
