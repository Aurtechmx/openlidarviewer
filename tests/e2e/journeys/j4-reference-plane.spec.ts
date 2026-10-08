/**
 * J4 Reference plane, as P2 uses it on the LAS 1.4 survey file: placed at the
 * scan minimum, readout honest about its sources and units, and with no effect
 * on measurements or exports.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  buildSurveyLas14,
  dropBytes,
  downloadBytes,
  openWith,
  sha256Hex,
  startJourney,
} from './helpers/journey';
import { denseGridPlyBytes, pinNavigationPanel, showWorkspaceMode, waitForCameraSettled } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey; the phone section is covered by referencePlane.spec.ts');

async function planeSection(page: Page): Promise<Locator> {
  const section = page.locator('details.olv-section-collapsible', {
    has: page.locator('summary', { hasText: 'Reference plane' }),
  });
  if (!(await section.evaluate((d) => (d as HTMLDetailsElement).open))) await section.locator('summary').click();
  return section;
}

async function measurementText(page: Page): Promise<string> {
  // textContent: innerText spacing depends on whether the panel is laid out.
  return ((await page.locator('.olv-mp-row').first().textContent()) ?? '').replace(/\s+/g, ' ');
}

async function exportXyz(page: Page): Promise<string> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
  const dl = page.waitForEvent('download');
  await panel.locator('.olv-bc-convert').click();
  const { bytes } = await downloadBytes(await dl);
  // The header carries a timestamp-free provenance block; hash the whole file.
  return sha256Hex(bytes);
}

test('P2: scan-minimum plane states its sources and units and changes no number', async ({ page }, info) => {
  test.setTimeout(120_000);
  const j = startJourney(page, info, 'j4');
  const survey = await buildSurveyLas14();

  await j.step('open the survey file', async () => {
    await pinNavigationPanel(page);
    await openWith(page, survey.bytes, 'survey-14.las');
    await waitForCameraSettled(page);
  });

  await j.step('place a distance and export XYZ with the plane off', async () => {
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 1, y: 1, z: 0 });
      api.placeMeasurementPoint({ x: 4, y: 5, z: 0 });
    });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
    await page.keyboard.press('Escape');
  });
  const measureOff = await measurementText(page);
  const xyzOff = await exportXyz(page);

  const section = await planeSection(page);
  const body = section.locator('.olv-refplane-body');
  const readout = body.locator('.olv-refplane-readout');

  await j.step('turn the plane on at the scan minimum', async () => {
    await section.locator('.olv-refplane-toggle').click();
    await body.getByRole('button', { name: 'Use scan minimum' }).click();
    await expect(body).toHaveAttribute('data-drawn', 'true');
  });

  await j.step('the readout names orientation, origin, elevation and its source, spacing and units', async () => {
    await expect(body.locator('.olv-refplane-honesty')).toHaveText('Reference plane, not measured terrain.');
    await expect(readout).toContainText('Orientation: Horizontal');
    await expect(readout).toContainText(/Origin: X [\d.-]+\sm, Y [\d.-]+\sm/);
    const minZ = Math.min(...Array.from({ length: survey.count }, (_, k) => {
      const i = Math.floor(k / 30);
      const jj = k % 30;
      let z = 1500 + 0.1 * i + 0.05 * jj;
      if (k % 37 === 0) z -= 8;
      else if (k % 41 === 0) z += 30;
      return z;
    }));
    // The lowest point here is a class 7 noise return, eight metres under the
    // ground: the readout must call it the lowest point, not ground.
    await expect(readout).toContainText('lowest point in the scan, not ground');
    const text = await readout.innerText();
    const elev = text.match(/Elevation: (-?[\d.]+)/);
    expect(elev, `readout: ${text}`).not.toBeNull();
    // The elevation a surveyor reads is the file's own height, to the millimetre.
    const shown = Number(elev![1]);
    expect(Math.abs(shown - minZ), `elevation shown ${shown}, scan minimum in the file ${minZ}`).toBeLessThan(0.0015);
    await expect(readout).toContainText(/Grid [\d.]+\sm/);
    // The file declares no vertical unit, so a metre elevation is borrowed
    // from the horizontal unit and must say so.
    await expect(readout).toContainText(/vertical unit.*assumed|assumed.*vertical/i);
  });

  await j.step('change the spacing and toggle with B', async () => {
    await body.getByLabel('Spacing').selectOption('fixed');
    const every = body.getByLabel('Every');
    await every.fill('2');
    await every.press('Enter');
    await expect(readout).toContainText(/Grid 2\sm/);
    await page.locator('.olv-canvas').focus();
    await page.keyboard.press('b');
    await expect(section.locator('.olv-refplane-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('b');
    await expect(section.locator('.olv-refplane-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  await j.step('measurement and XYZ export are identical with the plane on', async () => {
    expect(await measurementText(page)).toBe(measureOff);
    expect(await exportXyz(page)).toBe(xyzOff);
  });
});

test('P2: with layers that share no datum the plane refuses and says why', async ({ page }, info) => {
  test.setTimeout(90_000);
  const j = startJourney(page, info, 'j4');
  const survey = await buildSurveyLas14();
  await j.step('open the survey file, then add a scan with no CRS', async () => {
    await pinNavigationPanel(page);
    await openWith(page, survey.bytes, 'survey-14.las');
    await dropBytes(page, denseGridPlyBytes(), 'dense-grid.ply');
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  });
  await j.step('Use scan minimum is refused with the reason', async () => {
    const section = await planeSection(page);
    await section.locator('.olv-refplane-toggle').click();
    const body = section.locator('.olv-refplane-body');
    await body.getByRole('button', { name: 'Use scan minimum' }).click();
    await expect(body.locator('.olv-refplane-readout')).toContainText('The open layers share no datum, so the plane is not drawn.');
    await expect(body).toHaveAttribute('data-drawn', 'false');
  });
});
