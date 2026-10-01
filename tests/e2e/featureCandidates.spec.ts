import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  activate,
  dropTinyLas,
  dropTinyPly,
  expectHittable,
  railChromeSettled,
  openAnalysePage,
} from './helpers';

/**
 * Feature-candidate review surface (v0.6.8) — the context-sensitive launcher.
 *
 * The contract: the launcher appears ONLY for a scan that carries a
 * classification, and the review list is honest — every result is a DERIVED
 * candidate, never a detected building or surveyed conductor.
 *
 * `tiny.las` carries a classification including class 6 (building) and no class
 * 14 (wire), so it drives both the building-candidate path and the "no wire
 * points" path. `tiny.ply` carries no classification, so it drives the absence
 * assertion. The extraction maths itself is pinned in the Node tests.
 */

test('offers feature candidates for a classified scan, framed as candidates', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  // Its own page, listed on the Analyse home only when the scan carries it.
  await openAnalysePage(page, 'features');

  const launcher = page.locator('.olv-feature-launcher');
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  // The launcher states the honest framing before anything is extracted.
  await expect(launcher).toContainText('derived candidate');

  await expect(page.locator('.olv-feature-review')).toBeHidden();
  const extract = launcher.locator('.olv-feature-launcher-action');
  await expectHittable(extract);
  await activate(extract);

  const review = page.locator('.olv-feature-review');
  await expect(review).toBeVisible();
  // Both sections render; the conductor path is the "no wire points" one.
  await expect(review).toContainText('Building footprints');
  await expect(review).toContainText('Conductor fit');
  await expect(review).toContainText('No wire-classified points');
});

test('offers no feature candidates for a scan with no classification', async ({ page }) => {
  await page.goto('/?test=1');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalysePage(page, 'terrain');
  expect(await page.locator('.olv-ah-row[data-analysis="features"]').count()).toBe(0);

  // tiny.ply carries RGB only, no classification channel, so the launcher
  // never appears.
  expect(await page.locator('.olv-feature-launcher').count()).toBe(0);
});

/**
 * `withheld-flags.las` with its class-2 points relabelled as buildings (class
 * 6). Three of them are Withheld, so extraction reads 7 of 10.
 */
function withheldBuildings(): number[] {
  const b = readFileSync(fileURLToPath(new URL('../fixtures/withheld-flags.las', import.meta.url)));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const offset = v.getUint32(96, true);
  const length = v.getUint16(105, true);
  const count = Number(v.getBigUint64(247, true));
  // PDRF 6 holds the classification at byte 16 of each record.
  for (let i = 0; i < count; i++) {
    const at = offset + i * length + 16;
    if (b[at] === 2) b[at] = 6;
  }
  return [...b];
}

test('names the Withheld building points extraction left out', async ({ page }) => {
  await page.goto('/?test=1');
  const dt = await page.evaluateHandle((bytes) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(bytes)], 'withheld-buildings.las'));
    return d;
  }, withheldBuildings());
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await railChromeSettled(page);
  await openAnalysePage(page, 'features');
  const launcher = page.locator('.olv-feature-launcher');
  await expect(launcher).toBeVisible({ timeout: 20_000 });
  await activate(launcher.locator('.olv-feature-launcher-action'));
  await expect(page.locator('.olv-feature-withheld')).toHaveText(
    'Building and wire points: 7 of 10 analysed; Withheld excluded: 3',
  );
});
