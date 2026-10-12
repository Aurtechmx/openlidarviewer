/**
 * recognisedUnsupported.spec.ts
 *
 * A dropped Autodesk ReCap RCS file (recognised by its ADOCT magic) is named
 * and explained on the open-error toast, rather than given the generic
 * unknown-format report. The fixture is a tiny synthetic byte array built here.
 */
import { expect, test } from '@playwright/test';
import { suppressOnboardingTour } from './helpers';
import { isBenignPageError } from './pageErrors';

test('a dropped .rcs file gets the ReCap export message, with no errors', async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(e.message)) pageErrors.push(e.message); });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await suppressOnboardingTour(page);
  await page.goto('/?test=1');

  // "ADOCT" followed by a little filler: the magic is all recognition reads.
  const bytes = [0x41, 0x44, 0x4f, 0x43, 0x54, ...Array.from({ length: 251 }, (_, i) => (i * 37) & 0xff)];
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'sample.rcs'));
    return dt;
  }, bytes);
  await page.dispatchEvent('body', 'drop', { dataTransfer });

  const toast = page.locator('.olv-toast');
  await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 30_000 });
  const text = page.locator('.olv-toast-text');
  await expect(text).toContainText('Autodesk ReCap scan (.rcs) — not supported yet');
  await expect(text).toContainText('In Autodesk ReCap, export the scan as E57 or LAS, then open that file here.');
  // Not the generic failure report.
  await expect(text).not.toContainText('not recognised as a point cloud');
  await expect(toast.getByRole('button', { name: 'Copy report', exact: true })).toHaveCount(0);
  // Nothing was opened, and the app is still usable.
  await expect(page.locator('.olv-empty')).toBeVisible();

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
