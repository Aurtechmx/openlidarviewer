/**
 * J5 Measure and analyse, as P2 on the survey files.
 *
 * Measurements are placed through the test seam at known scene coordinates,
 * so each value has a ground truth. The scene is Z-up for LAS.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildSurveyLas14, loadLasWriter, openWith, startJourney } from './helpers/journey';
import { openAnalysePanel } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

type Api = {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  finishMeasurement: () => void;
};

async function place(page: Page, kind: string, pts: Array<[number, number, number]>): Promise<void> {
  await page.evaluate(({ kind, pts }) => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind(kind);
    for (const [x, y, z] of pts) api.placeMeasurementPoint({ x, y, z });
    if (pts.length > 2) api.finishMeasurement();
  }, { kind, pts });
}

async function openMeasure(page: Page): Promise<void> {
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}

test('P2: distance, sloped distance and polyline match ground truth', async ({ page }, info) => {
  const j = startJourney(page, info, 'j5');
  const survey = await buildSurveyLas14();
  await j.step('open the survey file and Measure', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await openMeasure(page);
  });
  await j.step('a 3-4-5 distance reads 5 m', async () => {
    await place(page, 'distance', [[0, 0, 0], [3, 4, 0]]);
    const row = page.locator('.olv-mp-row').first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    expect((await row.innerText()).replace(/\s+/g, ' ')).toMatch(/^5\.0+ m\b/);
  });
  await j.step('a sloped distance (run 3, rise 4) reads 5 m', async () => {
    await place(page, 'distance', [[0, 0, 0], [3, 0, 4]]);
    const rows = page.locator('.olv-mp-row');
    await expect(rows).toHaveCount(2, { timeout: 5_000 });
    expect((await rows.nth(1).innerText()).replace(/\s+/g, ' ')).toMatch(/^5\.0+ m\b/);
  });
  await j.step('a polyline of two 5 m legs reads 10 m', async () => {
    await place(page, 'polyline', [[0, 0, 0], [3, 4, 0], [6, 8, 0]]);
    const rows = page.locator('.olv-mp-row');
    await expect(rows).toHaveCount(3, { timeout: 5_000 });
    expect((await rows.nth(2).innerText()).replace(/\s+/g, ' ')).toMatch(/^10\.0+ m\b/);
  });
});

test('P2: a rise on a file with no declared vertical unit says the unit is assumed', async ({ page }, info) => {
  // FINDING J5-RISE: the reference plane on this file says "Heights are
  // assumed to be in the horizontal unit (vertical unit not declared)", but a
  // distance with a rise reads "Rise 4.0000 m ... datum resolved" with no
  // caveat in the panel or the hint bar. Recorded as an expected failure.
  test.fail();
  const j = startJourney(page, info, 'j5');
  const survey = await buildSurveyLas14();
  await j.step('open the survey file and Measure', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await openMeasure(page);
  });
  await j.step('a sloped distance states that heights borrow the horizontal unit', async () => {
    await place(page, 'distance', [[0, 0, 0], [3, 0, 4]]);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
    const visible = [
      await page.locator('.olv-measure-panel').innerText(),
      await page.locator('.olv-measure-bar').innerText(),
    ].join(' ').replace(/\s+/g, ' ');
    await info.attach('measure-visible-text.txt', { body: visible, contentType: 'text/plain' });
    expect(visible, 'a caveat about the vertical unit').toMatch(/vertical unit[^.]*(not declared|unknown|assumed)|heights? (are )?assumed/i);
  });
});

test('P2: on a compound CRS with feet heights, a 3D distance is flagged as not reliable', async ({ page }, info) => {
  const j = startJourney(page, info, 'j5');
  const { writeLas14 } = await loadLasWriter();
  const { VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE } = await import('../../../src/render/measure/format');
  const N = 20;
  const n = N * N;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) { x[k] = 500000 + (k % N); y[k] = 4100000 + Math.floor(k / N); z[k] = 5000 + (k % 7); }
  const bytes = writeLas14({ count: n, x, y, z }, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 });
  await j.step('open the compound-CRS file', async () => {
    await openWith(page, bytes, 'compound-ftus.las');
    await openMeasure(page);
  });
  await j.step('the distance carries the compound-CRS caveat', async () => {
    await place(page, 'distance', [[0, 0, 0], [3, 0, 4]]);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
    // The notice is in the measure hint bar, which stays on screen while measuring.
    await expect(page.locator('.olv-measure-bar')).toContainText(VERTICAL_UNIT_MISMATCH_MEASURE_NOTICE);
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    // The breakdown converts the rise: 4 US survey feet is 1.2192 m.
    await expect(page.locator('.olv-mp-row').first()).toBeVisible();
    expect(await page.locator('.olv-measure-panel').innerText()).toMatch(/Rise 1\.219\d m/);
  });
});

test('P2: the state strip names the declared vertical CRS and unit (NAVD88 height, US survey feet)', async ({ page }, info) => {
  // FINDING J5-VSTRIP: a file declaring VerticalCSTypeGeoKey 6360 (NAVD88
  // height, ftUS) and VerticalUnitsGeoKey 9003 shows "Vertical: unknown" on
  // the strip while Measure converts its heights from US survey feet and warns
  // about a compound CRS. Recorded as an expected failure.
  test.fail();
  const j = startJourney(page, info, 'j5');
  const { writeLas14 } = await loadLasWriter();
  const N = 10;
  const n = N * N;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) { x[k] = 500000 + (k % N); y[k] = 4100000 + Math.floor(k / N); z[k] = 5000; }
  const bytes = writeLas14({ count: n, x, y, z }, { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 });
  await j.step('open the compound-CRS file', () => openWith(page, bytes, 'compound-ftus.las'));
  await j.step('the vertical item is not "unknown"', async () => {
    await expect(page.locator('.olv-state-strip .olv-ss-vertical')).not.toHaveText(/Vertical: unknown/, { timeout: 5_000 });
  });
});

test('P2: terrain analysis excludes noise classes 7 and 18 and shows the count', async ({ page }, info) => {
  test.setTimeout(150_000);
  const j = startJourney(page, info, 'j5');
  const survey = await buildSurveyLas14();
  const noise = (survey.classCounts[7] ?? 0) + (survey.classCounts[18] ?? 0);
  await j.step('open the survey file', () => openWith(page, survey.bytes, 'survey-14.las'));
  await j.step('run terrain analysis', async () => {
    await openAnalysePanel(page);
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, { timeout: 90_000 });
  });
  await j.step('the excluded count equals the noise returns in the file', async () => {
    const panel = page.locator('.olv-analyse-panel');
    // Notes are a collapsed section; their text is in the DOM either way.
    const text = ((await panel.textContent()) ?? '').replace(/\s+/g, ' ');
    await info.attach('analyse-panel.txt', { body: text, contentType: 'text/plain' });
    const m = text.match(/Excluded ([\d,]+) classified/);
    expect(m, 'an exclusion line').not.toBeNull();
    expect(Number(m![1].replace(/,/g, ''))).toBe(noise);
  });
});
