import { test, expect, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * Optional report signing, end to end: the Export panel controls, the key
 * surviving a reload, the signed file, and the verifier dialog's results.
 * The crypto itself is covered by tests/reportSignature.test.ts.
 */

/** Load a scan, place one measurement and open the Export panel's Products lane. */
async function prepare(page: Page): Promise<Locator> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void };
    }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  const head = panel.locator('.olv-export-products-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  await expect(panel.locator('[data-testid="export-integrity-report"]')).toBeEnabled();
  return panel;
}

async function exportText(page: Page, panel: Locator): Promise<string> {
  const dl = page.waitForEvent('download');
  await panel.locator('[data-testid="export-integrity-report"]').click();
  const path = await (await dl).path();
  if (!path) throw new Error('no download path');
  return readFileSync(path, 'utf8');
}

async function createKey(panel: Locator): Promise<void> {
  await panel.locator('[data-testid="report-sign-toggle"]').click();
  await expect(panel.locator('[data-testid="report-sign-create"]')).toBeVisible();
  await panel.locator('[data-testid="report-sign-create"]').click();
  await expect(panel.locator('[data-testid="report-sign-key-id"]')).toBeVisible({ timeout: 10_000 });
}

async function verify(page: Page, file: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.locator('.olv-palette-input').fill('verify integrity');
  await page.locator('.olv-palette-row').filter({ hasText: 'Verify report with verification checksum' }).first().click();
  await (await chooser).setFiles(file);
}

test('signing is off by default and an unsigned export carries no signature', async ({ page }) => {
  const panel = await prepare(page);
  await expect(panel.locator('[data-testid="report-sign-toggle"]')).not.toBeChecked();
  const report = JSON.parse(await exportText(page, panel));
  expect(report.reportSignature).toBeUndefined();
});

test('first use explains the key, then signs; the key survives a reload', async ({ page }) => {
  let panel = await prepare(page);
  await panel.locator('[data-testid="report-sign-toggle"]').click();
  const intro = panel.getByRole('group', { name: 'Create a signing key' });
  await expect(intro).toContainText('cannot be exported');
  await expect(intro).toContainText('clearing site data deletes it');
  await expect(intro).toContainText('does not show who that person is');
  // Until the key exists the choice is not applied.
  await expect(panel.locator('[data-testid="report-sign-toggle"]')).not.toBeChecked();
  await panel.locator('[data-testid="report-sign-create"]').click();
  await expect(panel.locator('[data-testid="report-sign-toggle"]')).toBeChecked();
  const keyId = (await panel.locator('[data-testid="report-sign-key-id"]').textContent())!.replace('Key id: ', '');
  await panel.locator('[data-testid="report-sign-label"]').fill('Field team');

  const text = await exportText(page, panel);
  const signed = JSON.parse(text);
  expect(signed.reportSignature.keyId).toBe(keyId);
  expect(signed.reportSignature.signerLabel).toBe('Field team');
  expect(text).not.toMatch(/"d"\s*:/);

  // A fresh page load finds the stored key and does not ask to create one.
  panel = await prepare(page);
  await panel.locator('[data-testid="report-sign-toggle"]').click();
  await expect(panel.locator('[data-testid="report-sign-key-id"]')).toContainText(keyId);
  await expect(panel.locator('[data-testid="report-sign-create"]')).toHaveCount(0);
  const again = JSON.parse(await exportText(page, panel));
  expect(again.reportSignature.keyId).toBe(keyId);
});

test('Show and Copy expose only the public key', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  const panel = await prepare(page);
  await createKey(panel);
  const show = panel.locator('[data-testid="report-sign-show"]');
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await show.click();
  await expect(show).toHaveAttribute('aria-expanded', 'true');
  const keyText = await panel.locator('[data-testid="report-sign-public-key"]').inputValue();
  expect(Object.keys(JSON.parse(keyText)).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  await panel.locator('[data-testid="report-sign-copy"]').click();
  await expect(panel.locator('[data-testid="report-sign-status"]')).toHaveText(/copied|could not copy/i);
});

test('the verifier reads signer, supplied key and tampering plainly', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  await panel.locator('[data-testid="report-sign-show"]').click();
  const keyText = await panel.locator('[data-testid="report-sign-public-key"]').inputValue();
  const file = test.info().outputPath('signed.json');
  writeFileSync(file, await exportText(page, panel));

  await verify(page, file);
  const dialog = page.locator('[data-testid="report-verify"] [role="dialog"]');
  await expect(page.locator('[data-testid="report-verify-sig-unverified"]')).toHaveText("Signed, signer unverified");
  await expect(page.locator('[data-testid="report-verify-valid"]')).toBeVisible();

  // The dialog is labelled and the page has no new accessibility violations.
  const axe = await new AxeBuilder({ page }).include('[data-testid="report-verify"]').analyze();
  expect(axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);

  const input = page.locator('[data-testid="report-verify-trusted-key"]');
  await input.fill(keyText);
  await page.locator('[data-testid="report-verify-compare"]').click();
  await expect(page.locator('[data-testid="report-verify-sig-trusted"]')).toHaveText('Signed by the key you supplied');
  await input.fill('A'.repeat(43));
  await page.locator('[data-testid="report-verify-compare"]').click();
  await expect(page.locator('[data-testid="report-verify-sig-different"]')).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await page.locator('[data-testid="report-verify-close"]').click();

  const tampered = JSON.parse(readFileSync(file, 'utf8'));
  tampered.findings[0].value = 999999;
  const bad = test.info().outputPath('signed-bad.json');
  writeFileSync(bad, JSON.stringify(tampered));
  await verify(page, bad);
  await expect(page.locator('[data-testid="report-verify-invalid"]').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="report-verify-sig-invalid"]')).toHaveText('Signature does not verify');
});

test('the signing controls work from the keyboard and fit a 343 px column', async ({ page }) => {
  const panel = await prepare(page);
  const toggle = panel.locator('[data-testid="report-sign-toggle"]');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(panel.locator('[data-testid="report-sign-create"]')).toBeVisible();
  await panel.locator('[data-testid="report-sign-create"]').focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('[data-testid="report-sign-key-id"]')).toBeVisible({ timeout: 10_000 });
  await panel.locator('[data-testid="report-sign-show"]').focus();
  await page.keyboard.press('Enter');
  await expect(panel.locator('[data-testid="report-sign-public-key"]')).toBeVisible();
  // A 375 px phone leaves a 343 px column after the 16 px gutters. The phone
  // layout hides the workspace tabs this spec uses to reach the panel, so the
  // block is narrowed in place and checked for overflow instead.
  const overflow = await panel.locator('[data-testid="report-signing"]').evaluate((root) => {
    (root as HTMLElement).style.width = '343px';
    return [root, ...root.querySelectorAll('*')].filter((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== 'inline').length;
  });
  expect(overflow).toBe(0);
  const axe = await new AxeBuilder({ page }).include('[data-testid="report-signing"]').analyze();
  expect(axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
});

test('two clicks in one tick leave signing off, and the next export is unsigned', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  const toggle = panel.locator('[data-testid="report-sign-toggle"]');
  await toggle.click(); // off
  await expect(toggle).not.toBeChecked();
  // Count the key-store reads the page starts and finishes, so the test waits
  // for the stale lookup to answer instead of sleeping.
  await page.evaluate(() => {
    const probe = { started: 0, done: 0 };
    (window as unknown as { __keyReads: typeof probe }).__keyReads = probe;
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['get']>) {
      const req = get.apply(this, args);
      probe.started += 1;
      const finish = (): void => { probe.done += 1; };
      req.addEventListener('success', finish);
      req.addEventListener('error', finish);
      return req;
    };
  });
  // On, then off, before the key lookup can answer.
  await toggle.evaluate((b) => { (b as HTMLInputElement).click(); (b as HTMLInputElement).click(); });
  await page.waitForFunction(() => {
    const probe = (window as unknown as { __keyReads: { started: number; done: number } }).__keyReads;
    return probe.started >= 1 && probe.done >= probe.started;
  });
  // The lookup's continuation runs after its request settles; let it run.
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(toggle).not.toBeChecked();
  await expect(panel.locator('[data-testid="report-sign-status"]')).not.toContainText(/will be signed/i);
  const report = JSON.parse(await exportText(page, panel));
  expect(report.reportSignature).toBeUndefined();
});

test('a key file over 4 KB is refused with a message', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  const dir = mkdtempSync(join(tmpdir(), 'olv-big-key-'));
  try {
    const out = join(dir, 'key.txt');
    writeFileSync(out, 'x'.repeat(5000), { mode: 0o600, flag: 'wx' });
    const signed = join(dir, 'signed.json');
    writeFileSync(signed, await exportText(page, panel), { mode: 0o600, flag: 'wx' });
    await verify(page, signed);
    await expect(page.locator('[data-testid="report-verify-signature"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="report-verify-trusted-file"]').setInputFiles(out);
    await expect(page.locator('[data-testid="report-verify-key-file-note"]')).toContainText(/too large/i);
    await expect(page.locator('[data-testid="report-verify-trusted-key"]')).toHaveValue('');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loading a key file replaces a verdict shown for the typed key', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  await panel.locator('[data-testid="report-sign-show"]').click();
  const keyText = await panel.locator('[data-testid="report-sign-public-key"]').inputValue();
  const dir = mkdtempSync(join(tmpdir(), 'olv-key-file-'));
  try {
    const other = join(dir, 'other.txt');
    writeFileSync(other, 'A'.repeat(43), { mode: 0o600, flag: 'wx' });
    const big = join(dir, 'big.txt');
    writeFileSync(big, 'x'.repeat(5000), { mode: 0o600, flag: 'wx' });
    const signed = join(dir, 'signed.json');
    writeFileSync(signed, await exportText(page, panel), { mode: 0o600, flag: 'wx' });
    await verify(page, signed);
    const input = page.locator('[data-testid="report-verify-trusted-key"]');
    const note = page.locator('[data-testid="report-verify-compare-note"]');
    await input.fill(keyText);
    await page.locator('[data-testid="report-verify-compare"]').click();
    await expect(page.locator('[data-testid="report-verify-sig-trusted"]')).toBeVisible({ timeout: 10_000 });

    // A file sets the text from code, with no input event; the verdict for the old key must go.
    await page.locator('[data-testid="report-verify-trusted-file"]').setInputFiles(other);
    await expect(input).toHaveValue('A'.repeat(43));
    // The chooser is cleared, so picking the same file again fires `change` again.
    await expect.poll(() => page.locator('[data-testid="report-verify-trusted-file"]').evaluate((el) => (el as HTMLInputElement).value)).toBe('');
    await expect(page.locator('[data-testid="report-verify-sig-trusted"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="report-verify-sig-unverified"]')).toBeVisible();
    await expect(note).toHaveText('The key changed. Press Compare to check it.');

    // The same holds when the size check clears the box.
    await input.fill(keyText);
    await page.locator('[data-testid="report-verify-compare"]').click();
    await expect(page.locator('[data-testid="report-verify-sig-trusted"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="report-verify-trusted-file"]').setInputFiles(big);
    await expect(input).toHaveValue('');
    await expect(page.locator('[data-testid="report-verify-sig-trusted"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="report-verify-compare"]')).toBeEnabled();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key can be deleted after confirming, and signing then stops', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  await panel.locator('[data-testid="report-sign-delete"]').click();
  await panel.locator('[data-testid="report-sign-delete-cancel"]').click();
  await expect(panel.locator('[data-testid="report-sign-key-id"]')).toBeVisible();
  await panel.locator('[data-testid="report-sign-delete"]').click();
  await panel.locator('[data-testid="report-sign-delete-confirm"]').click();
  await expect(panel.locator('[data-testid="report-sign-create"]')).toBeVisible();
  await expect(panel.locator('[data-testid="report-sign-toggle"]')).not.toBeChecked();
  expect(JSON.parse(await exportText(page, panel)).reportSignature).toBeUndefined();
});

test('the key text says signed reports can be linked and a private window forgets the key', async ({ page }) => {
  const panel = await prepare(page);
  await panel.locator('[data-testid="report-sign-toggle"]').click();
  const intro = panel.getByRole('group', { name: 'Create a signing key' });
  await expect(intro).toContainText("carries this key's id");
  await expect(intro).toContainText('private window forgets it');
  await expect(panel).not.toContainText(/webcrypto/i);
});

test('a hostile report opens the dialog with a reason instead of failing silently', async ({ page }) => {
  await prepare(page);
  const cases: Array<[string, string]> = [
    ['1e999', '{"digest":"x","digestAlgorithm":"SHA-256","findings":[{"value":1e999}]}'],
    ['deep', '{"digest":"x","digestAlgorithm":"SHA-256","findings":[' + '['.repeat(30_000) + ']'.repeat(30_000) + ']}'],
  ];
  for (const [name, text] of cases) {
    const file = test.info().outputPath(`hostile-${name}.json`);
    writeFileSync(file, text);
    await verify(page, file);
    await expect(page.locator('[data-testid="report-verify"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="report-verify"]')).toContainText(/cannot be checked|not valid JSON|not a report/i);
    await page.locator('[data-testid="report-verify-close"]').click();
  }
});

test('a signed report with a repeated member name fails in the dialog', async ({ page }) => {
  const panel = await prepare(page);
  await createKey(panel);
  const text = await exportText(page, panel);
  const file = test.info().outputPath('dup.json');
  writeFileSync(file, '{"findings":[],' + text.trim().slice(1));
  await verify(page, file);
  await expect(page.locator('[data-testid="report-verify-sig-invalid"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('[data-testid="report-verify"]')).toContainText(/repeats a member name/i);
});

test('a tab that loses the key-creation race adopts the winning key', async ({ page, context }) => {
  const panelA = await prepare(page);
  const second = await context.newPage();
  const panelB = await prepare(second);
  await panelB.locator('[data-testid="report-sign-toggle"]').click();
  await expect(panelB.locator('[data-testid="report-sign-create"]')).toBeVisible();
  await createKey(panelA);
  const winner = (await panelA.locator('[data-testid="report-sign-key-id"]').textContent())!;
  // Make the second tab's lookup miss the stored key, so its create reaches the
  // atomic add and meets the key the first tab wrote.
  await second.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    // Only the first lookup misses; reloading the winner afterwards reads normally.
    IDBObjectStore.prototype.get = function (this: IDBObjectStore) {
      IDBObjectStore.prototype.get = get;
      return get.call(this, '__none__');
    };
  });
  await panelB.locator('[data-testid="report-sign-create"]').click();
  await expect(panelB.locator('[data-testid="report-sign-key-id"]')).toHaveText(winner, { timeout: 10_000 });
  await expect(panelB.locator('[data-testid="report-sign-status"]')).not.toContainText(/could not be created/i);
});
