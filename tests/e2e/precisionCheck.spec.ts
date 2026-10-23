import { test, expect } from '@playwright/test';
import { dropTerrainAccessUtmLas } from './helpers';

/**
 * The Performance panel checks precision at the current view: the per-draw
 * bound for the open scan against a chosen limit, in one sentence, and a
 * certificate of it to copy.
 */
test('the Performance panel checks precision at this view and copies a certificate', async ({ page, context, browserName }) => {
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });

  await page.locator('.olv-quality-button').click();
  const section = page.locator('.olv-precision');
  await expect(section).toBeVisible({ timeout: 10_000 });
  await expect(section).toContainText('Precision at this view');
  const line = section.locator('.olv-precision-line');
  await expect(line).toHaveText(/^Rendering error at most .* at this view \(round-to-nearest; .* worst case under the spec\), inside the 1 mm limit\.$/);
  await expect(line).toHaveAttribute('aria-live', 'polite');
  await expect(section.locator('.olv-chip', { hasText: '1 mm' })).toHaveAttribute('aria-pressed', 'true');

  await section.locator('.olv-chip', { hasText: '10 cm' }).click();
  await expect(line).toContainText('inside the 10 cm limit');
  await expect(section.locator('.olv-chip', { hasText: '10 cm' })).toHaveAttribute('aria-pressed', 'true');
  await section.getByRole('button', { name: 'Check precision' }).click();
  await expect(line).toContainText('inside the 10 cm limit');

  const copy = section.getByRole('button', { name: 'Copy certificate' });
  await expect(copy).toBeEnabled();
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await copy.click();
    await expect(section.locator('.olv-precision-note')).toHaveText('Certificate copied.');
    const certificate = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(certificate.kind).toBe('olv.draw-precision-certificate');
    expect(certificate.result.boundState).toBe('PASS_BOUND');
    expect(certificate.result.bounds.map((b: { contract: string }) => b.contract)).toEqual(['rn', 'faithful']);
    expect(certificate.camera.positionInScanCoordinates).toHaveLength(3);
    expect(certificate.dataset.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(certificate.requirement.toleranceMetres).toBe(0.1);
    expect(certificate.scopeDigest).toMatch(/^[0-9a-f]{64}$/);
  } else {
    await copy.click();
    await expect(section.locator('.olv-precision-note')).toHaveText(/Certificate copied\.|saved as a file/);
  }
});

test('with no scan open the panel asks for one and offers no certificate', async ({ page }) => {
  await page.goto('/?test=1');
  await page.locator('.olv-quality-button').click();
  const section = page.locator('.olv-precision');
  await expect(section.locator('.olv-precision-line')).toHaveText('Open a scan to check its precision.');
  await expect(section.getByRole('button', { name: 'Copy certificate' })).toBeDisabled();
});

test('an open panel follows the scene: it updates when a scan opens after it', async ({ page }) => {
  await page.goto('/?test=1');
  await page.locator('.olv-quality-button').click();
  const line = page.locator('.olv-precision .olv-precision-line');
  await expect(line).toHaveText('Open a scan to check its precision.');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  if (!(await page.locator('.olv-precision').isVisible())) await page.locator('.olv-quality-button').click();
  await expect(line).toHaveText(/^Rendering error at most .* inside the 1 mm limit\.$/, { timeout: 10_000 });
});
