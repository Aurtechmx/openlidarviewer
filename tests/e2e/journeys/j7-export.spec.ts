/**
 * J7 Export, as P2: "Give me a LAS 1.2 copy and a report."
 *
 * Every downloaded file is read back here, outside the app: the LAS header,
 * classes and provenance VLR, the XYZ header and rows, and the report JSON.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import {
  SAFE_FILE_NAME,
  buildSurveyLas14,
  downloadBytes,
  openWith,
  parseLasExport,
  parseXyzExport,
  sha256Hex,
  startJourney,
  type SurveyFixture,
} from './helpers/journey';
import { showWorkspaceMode } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

async function exportPanel(page: Page): Promise<Locator> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  await expect(panel.getByRole('checkbox', { name: 'Include classification' })).toBeVisible({ timeout: 20_000 });
  return panel;
}

async function openSurvey(page: Page): Promise<SurveyFixture> {
  const survey = await buildSurveyLas14();
  await openWith(page, survey.bytes, 'survey-14.las');
  return survey;
}

test('P2: LAS 1.2 is refused with every needed opt-in named, then written and read back', async ({ page }, info) => {
  test.setTimeout(120_000);
  const { LEGACY_CLASS_REINTERPRETATION_OPT_IN, LEGACY_OVERLAP_DROP_OPT_IN } = await import('../../../src/convert/types');
  const j = startJourney(page, info, 'j7');
  const survey = await j.step('open the LAS 1.4 survey file', () => openSurvey(page));
  const panel = await j.step('open Export', () => exportPanel(page));
  const status = panel.locator('.olv-export-status');
  const las12 = panel.locator('.olv-bc-pill', { hasText: 'LAS 1.2' });

  await j.step('LAS 1.2 is refused and the refusal names both opt-ins', async () => {
    await las12.click();
    let fired = false;
    page.once('download', () => { fired = true; });
    await panel.locator('.olv-bc-convert').click();
    await expect(status).toContainText('LAS 1.2 was not written', { timeout: 10_000 });
    const text = await status.innerText();
    await info.attach('refusal.txt', { body: text, contentType: 'text/plain' });
    // Class 10 (Rail) and 18 (High noise) are reserved numbers in LAS 1.2,
    // and points carry the overlap flag.
    expect(text).toContain(LEGACY_CLASS_REINTERPRETATION_OPT_IN);
    expect(text).toContain(LEGACY_OVERLAP_DROP_OPT_IN);
    expect(text).toMatch(/classes 10 and 18/);
    const shifted = (survey.classCounts[10] ?? 0) + (survey.classCounts[18] ?? 0);
    expect(text).toContain(`${shifted} points have classes 10 and 18`);
    expect(text).toContain(`${survey.overlapCount} points carry the overlap flag`);
    await expect(las12, 'the chosen format is kept').toHaveClass(/is-active/);
    expect(fired, 'no file is written on a refusal').toBe(false);
  });

  const out = await j.step('tick the two opt-ins and export', async () => {
    for (const label of [LEGACY_CLASS_REINTERPRETATION_OPT_IN, LEGACY_OVERLAP_DROP_OPT_IN]) {
      await panel.locator('.olv-export-fullres', { hasText: label }).locator('input[type="checkbox"]').check();
    }
    const dl = page.waitForEvent('download');
    await panel.locator('.olv-bc-convert').click();
    return downloadBytes(await dl);
  });

  await j.step('the written file matches the request', async () => {
    writeFileSync(info.outputPath(out.name), out.bytes);
    expect(out.name).toMatch(SAFE_FILE_NAME);
    expect(out.name).toMatch(/\.las$/);
    const las = parseLasExport(out.bytes);
    expect([las.versionMajor, las.versionMinor]).toEqual([1, 2]);
    expect(las.count).toBe(survey.count);
    // The numbers are written unchanged (the opt-in allows their meaning to change).
    const want: Record<number, number> = {};
    for (const c of las.classes) want[c] = (want[c] ?? 0) + 1;
    expect(want).toEqual(survey.classCounts);
    expect(las.generatingSoftware).toMatch(/^OpenLiDARViewer/);
    expect(las.vlrs.some((v) => v.userId === 'LASF_Projection' && v.recordId === 34735), 'GeoKeyDirectory VLR').toBe(true);
    // Provenance names the source file by its SHA-256.
    await info.attach('provenance.txt', { body: las.provenance, contentType: 'text/plain' });
    expect(las.provenance).toContain(sha256Hex(survey.bytes));
    // ...and records the request: the basis, and each opt-in the user ticked.
    expect(las.provenance).toContain(`Point basis: full file (${survey.count} points)`);
    expect(las.provenance).toContain(`Class 10 (${survey.classCounts[10]} points): the number is written unchanged`);
    expect(las.provenance).toContain(`Class 18 (${survey.classCounts[18]} points): the number is written unchanged`);
    expect(las.provenance).toContain(`${survey.overlapCount} points carry it`);
    expect(las.provenance.match(/Allowed in the export request\./g)).toHaveLength(3);
  });
});

test('P2: XYZ export carries the CRS, every point, and no classification claim', async ({ page }, info) => {
  const j = startJourney(page, info, 'j7');
  const survey = await j.step('open the survey file', () => openSurvey(page));
  const panel = await j.step('open Export', () => exportPanel(page));
  const out = await j.step('export XYZ', async () => {
    await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
    const dl = page.waitForEvent('download');
    await panel.locator('.olv-bc-convert').click();
    return downloadBytes(await dl);
  });
  await j.step('the XYZ reads back', async () => {
    expect(out.name).toMatch(SAFE_FILE_NAME);
    const xyz = parseXyzExport(new TextDecoder().decode(out.bytes));
    await info.attach('xyz-header.txt', { body: xyz.comments.join('\n'), contentType: 'text/plain' });
    expect(xyz.comments).toContain('# crs: EPSG:32613');
    expect(xyz.rows).toHaveLength(survey.count);
    for (const r of xyz.rows.slice(0, 50)) {
      expect(r[0]).toBeGreaterThanOrEqual(500000);
      expect(r[0]).toBeLessThan(500030);
      expect(r[1]).toBeGreaterThanOrEqual(4100000);
    }
    expect(xyz.comments.join('\n')).toContain(sha256Hex(survey.bytes));
    // XYZ has no classification column; neither the file nor the status may claim one.
    expect(xyz.comments.join('\n')).not.toMatch(/classif/i);
    const statusText = await panel.locator('.olv-export-status').innerText();
    expect(statusText, `status: ${statusText}`).not.toMatch(/with classification|classes (kept|written)/i);
  });
});

test('P2: a malformed EPSG is refused with its message', async ({ page }, info) => {
  const j = startJourney(page, info, 'j7');
  await j.step('open the survey file', () => openSurvey(page));
  const panel = await j.step('open Export', () => exportPanel(page));
  await j.step('type 4326junk into Target EPSG', async () => {
    await panel.locator('.olv-bc-pill', { hasText: 'Assign EPSG' }).click();
    await panel.locator('.olv-bc-field', { hasText: 'Target EPSG' }).locator('input').fill('4326junk');
    let fired = false;
    page.once('download', () => { fired = true; });
    await panel.locator('.olv-bc-convert').click();
    await expect(panel.locator('.olv-export-status')).toHaveText('The target EPSG must be a whole number such as 32614, or EPSG:32614.');
    expect(fired).toBe(false);
  });
});

test('P2: a signed integrity report names the source and verifies as signed, signer unverified', async ({ page }, info) => {
  test.setTimeout(90_000);
  const j = startJourney(page, info, 'j7');
  const survey = await j.step('open the survey file and measure', async () => {
    const s = await openSurvey(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
    });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
    return s;
  });
  const panel = await j.step('open Export products and create a signing key', async () => {
    const p = await exportPanel(page);
    const head = p.locator('.olv-export-products-head');
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
    await p.locator('[data-testid="report-sign-toggle"]').click();
    await p.locator('[data-testid="report-sign-create"]').click();
    await expect(p.locator('[data-testid="report-sign-key-id"]')).toBeVisible({ timeout: 10_000 });
    return p;
  });
  const file = info.outputPath('report.json');
  await j.step('export the report and read it', async () => {
    const dl = page.waitForEvent('download');
    await panel.locator('[data-testid="export-integrity-report"]').click();
    const out = await downloadBytes(await dl);
    expect(out.name).toMatch(SAFE_FILE_NAME);
    writeFileSync(file, out.bytes);
    const text = new TextDecoder().decode(out.bytes);
    const report = JSON.parse(text) as Record<string, unknown> & { reportSignature?: { keyId?: string } };
    expect(report.reportSignature?.keyId).toBeTruthy();
    const dataset = (report as { dataset?: { id?: string; sourceSha256?: string } }).dataset;
    expect(dataset?.id).toBe('survey-14');
    expect(dataset?.sourceSha256).toBe(sha256Hex(survey.bytes));
    expect(text).toMatch(/32613/);
    // The private key never leaves the browser.
    expect(text).not.toMatch(/"d"\s*:/);
  });
  await j.step('the verifier says signed, signer unverified', async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('verify integrity');
    await page.locator('.olv-palette-row').filter({ hasText: 'Verify report with verification checksum' }).first().click();
    await (await chooser).setFiles(file);
    await expect(page.locator('[data-testid="report-verify-sig-unverified"]')).toHaveText('Signed, signer unverified');
    await expect(page.locator('[data-testid="report-verify-valid"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="report-verify"] [role="dialog"]')).toBeHidden();
  });
});
