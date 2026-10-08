/**
 * J8 Save and reopen a session: "Save my work and pick it up tomorrow."
 *
 * The session file is parsed: it must carry the camera, the measurement and
 * the reference plane, and no point data. After a reload it is dropped back
 * with its scan and the same state returns. A file with damaged fields is
 * refused or repaired with a message, never a crash.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildSurveyLas14, cameraPose, downloadBytes, dropBytes, openWith, startJourney } from './helpers/journey';
import { openToolPage, pinNavigationPanel, reloadSettled, waitForCameraSettled } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

type Api = {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  getMeasurementCount: () => number;
};

const measurementCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __OLV_TEST_API__?: Api }).__OLV_TEST_API__?.getMeasurementCount() ?? -1);

async function planeSection(page: Page) {
  const section = page.locator('details.olv-section-collapsible', { has: page.locator('summary', { hasText: 'Reference plane' }) });
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator('summary').click();
  return section;
}

async function saveSession(page: Page): Promise<{ name: string; bytes: Uint8Array; json: Record<string, unknown> }> {
  await openToolPage(page, 'Measure');
  const dl = page.waitForEvent('download');
  await page.locator('.olv-mp-action', { hasText: 'Export' }).click();
  const out = await downloadBytes(await dl);
  return { ...out, json: JSON.parse(new TextDecoder().decode(out.bytes)) as Record<string, unknown> };
}

test('P1: save, reload, reopen: camera, measurement and plane come back; the file holds no points', async ({ page }, info) => {
  test.setTimeout(150_000);
  const j = startJourney(page, info, 'j8');
  const survey = await buildSurveyLas14();
  await j.step('open, measure, turn the plane on, move the camera', async () => {
    await pinNavigationPanel(page);
    await openWith(page, survey.bytes, 'survey-14.las');
    await waitForCameraSettled(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
    });
    await expect.poll(() => measurementCount(page)).toBe(1);
    await page.keyboard.press('Escape');
    const section = await planeSection(page);
    await section.locator('.olv-refplane-toggle').click();
    await section.getByRole('button', { name: 'Use scan minimum' }).click();
    await expect(section.locator('.olv-refplane-body')).toHaveAttribute('data-drawn', 'true');
    await page.getByRole('button', { name: 'Iso view', exact: true }).click();
    await waitForCameraSettled(page);
  });
  const poseBefore = await cameraPose(page);

  const saved = await j.step('save the session and read the file', async () => {
    const s = await saveSession(page);
    expect(s.name).toMatch(/\.olvsession$/);
    await info.attach('session.json', { body: Buffer.from(s.bytes), contentType: 'application/json' });
    expect(Array.isArray(s.json.measurements) && s.json.measurements.length).toBe(1);
    expect(s.json.camera, 'camera').toBeTruthy();
    expect(s.json.referencePlane, 'reference plane settings').toBeTruthy();
    // No point data: far smaller than the scan, and no array anywhere longer
    // than a handful of vertices (a measurement keeps its own clicked points).
    expect(s.bytes.byteLength).toBeLessThan(survey.bytes.byteLength / 2);
    const longest = (v: unknown): number => Array.isArray(v) ? Math.max(v.length, ...v.map(longest)) : v && typeof v === 'object' ? Math.max(0, ...Object.values(v).map(longest)) : 0;
    expect(longest(s.json), 'longest array in the session').toBeLessThan(50);
    return s;
  });

  await j.step('reload, open the scan, drop the session', async () => {
    await reloadSettled(page);
    await expect(page.locator('.olv-empty')).toBeVisible();
    await openWith(page, survey.bytes, 'survey-14.las');
    await waitForCameraSettled(page);
    await dropBytes(page, saved.bytes, saved.name);
    await expect.poll(() => measurementCount(page), { timeout: 20_000 }).toBe(1);
    await waitForCameraSettled(page);
  });

  await j.step('camera, measurement and plane are back', async () => {
    const pose = await cameraPose(page);
    for (let a = 0; a < 3; a++) {
      expect(pose.position[a]).toBeCloseTo(poseBefore.position[a], 2);
      expect(pose.target[a]).toBeCloseTo(poseBefore.target[a], 2);
    }
    const section = await planeSection(page);
    await expect(section.locator('.olv-refplane-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect(section.locator('.olv-refplane-readout')).toContainText('lowest point in the scan, not ground');
  });
});

test('P1: saving a session with class edits warns that the edits are not stored', async ({ page }, info) => {
  // J8-CLASS: the session file stores the class filter, not per-point classes
  // (sessionSnapshot.ts). Save session says so, and points to a LAS export.
  test.setTimeout(120_000);
  const j = startJourney(page, info, 'j8');
  const survey = await buildSurveyLas14();
  const { SESSION_CLASS_EDITS_NOT_STORED } = await import('../../../src/export/exportScanIdentity');
  await j.step('open and lasso-reclassify the whole view to class 6', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await waitForCameraSettled(page);
    // A lasso larger than the canvas selects every visible point (reclassify.spec.ts).
    const lasso = [{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5000, y: 5000 }, { x: 0, y: 5000 }];
    const n = await page.evaluate((l) => (window as unknown as { __OLV_TEST_API__: { reclassifyLasso: (l: Array<{ x: number; y: number }>, c: number) => number } }).__OLV_TEST_API__.reclassifyLasso(l, 6), lasso);
    expect(n).toBeGreaterThan(survey.count / 2);
    expect(await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: { classAt: (i: number) => number } }).__OLV_TEST_API__.classAt(1))).toBe(6);
  });
  await j.step('save the session: the warning names the loss and the way to keep the edits', async () => {
    await saveSession(page);
    await expect(page.locator('.olv-lasso-toast-msg')).toHaveText(SESSION_CLASS_EDITS_NOT_STORED, { timeout: 5_000 });
  });
});

test('P1: a session file with damaged fields is handled with a message', async ({ page }, info) => {
  const j = startJourney(page, info, 'j8');
  const survey = await buildSurveyLas14();
  await j.step('open the scan', () => openWith(page, survey.bytes, 'survey-14.las'));
  await j.step('drop a session whose camera and measurements are the wrong type', async () => {
    const damaged = JSON.stringify({ version: 7, camera: { position: 'up', target: [Number.NaN] }, measurements: 'none', views: 5, referencePlane: { spacing: -3 } });
    await dropBytes(page, new TextEncoder().encode(damaged), 'damaged.olvsession');
    const message = page.locator('.olv-toast-text, .olv-drop-error, [role="alert"]').filter({ hasText: /session|could not|ignored|invalid/i }).first();
    await expect(message).toBeVisible({ timeout: 10_000 });
    await info.attach('message.txt', { body: await message.innerText(), contentType: 'text/plain' });
  });
  await j.step('the scene is still usable', async () => {
    const pose = await cameraPose(page);
    expect(pose.position.every(Number.isFinite)).toBe(true);
    await page.getByRole('button', { name: 'Frame all' }).first().click();
    await waitForCameraSettled(page);
  });
});
