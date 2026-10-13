import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The open status: file name, detected format and loading scope on one line,
 * the stage under it, a refused file that never reads as ready, Cancel, and a
 * failure followed by a retry that opens.
 *
 * Deterministic: the whole-file read is held at a gate the test opens itself.
 * `File.prototype.arrayBuffer` is wrapped so a dropped file's read waits for
 * `__olvReadGate.open()`; the header reads go through `Blob.slice`, which is a
 * Blob, not a File, so preflight still runs. Nothing waits on a timer.
 */

const TINY_LAS = readFileSync(fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)));

async function installReadGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __olvReadGate: { waiting: number; open: () => void } };
    const held: Array<() => void> = [];
    w.__olvReadGate = {
      waiting: 0,
      open: () => { for (const go of held.splice(0)) go(); },
    };
    const read = Blob.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function (this: File): Promise<ArrayBuffer> {
      w.__olvReadGate.waiting += 1;
      return new Promise((resolve, reject) => {
        held.push(() => read.call(this).then(resolve, reject));
      });
    };
  });
}

async function drop(page: Page, bytes: Uint8Array | number[], name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ raw, fileName }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(raw)], fileName));
      return dt;
    },
    { raw: [...bytes], fileName: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

const politeText = (page: Page) => page.locator('body > .olv-visually-hidden[role="status"]');

/** Every value the polite region took, recorded from boot. */
async function recordPolite(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __olvPolite: string[] };
    w.__olvPolite = [];
    const node = document.querySelector('body > .olv-visually-hidden[role="status"]')!;
    new MutationObserver(() => {
      const t = node.textContent ?? '';
      if (t) w.__olvPolite.push(t);
    }).observe(node, { childList: true, characterData: true, subtree: true });
  });
}
const polite = (page: Page) => page.evaluate(() => (window as unknown as { __olvPolite: string[] }).__olvPolite);

test.describe('open status context', () => {
  test('shows the file name, format, scope and the reading stage, then opens', async ({ page }) => {
    await page.goto('/');
    await installReadGate(page);
    await recordPolite(page);
    await drop(page, TINY_LAS, 'survey-north.las');

    const toast = page.locator('.olv-toast');
    await expect(page.locator('.olv-toast-text')).toContainText('Reading file');
    await expect(page.locator('.olv-toast-file')).toHaveText('survey-north.las');
    await expect(page.locator('.olv-toast-facts')).toContainText('LAS');
    await expect(page.locator('.olv-toast-facts')).toContainText('Standard load');
    await expect(toast.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await expect(toast.getByRole('button', { name: 'Cancel loading' })).toBeVisible();

    await page.evaluate(() => (window as unknown as { __olvReadGate: { open: () => void } }).__olvReadGate.open());
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await expect(toast).toBeHidden({ timeout: 20_000 });
    // Completion names the file; the scan's ready line may take the region over.
    await expect(politeText(page)).toContainText('survey-north.las');
    const said = await polite(page);
    expect(said).toContain('Opening survey-north.las…');
    expect(said).toContain('Reading file');
    // Stages and milestones only: no byte counts, and the name is not repeated
    // with every update.
    expect(said.some((s) => /\bB of\b|MiB|KiB/.test(s))).toBe(false);
    expect(said.filter((s) => s.includes('survey-north.las')).length).toBeLessThanOrEqual(3);
  });

  test('a refused file shows why and never reaches a ready state', async ({ page }) => {
    await page.goto('/');
    await recordPolite(page);
    const bytes = new Uint8Array(4096);
    bytes.set([...'ASTM-E57'].map((c) => c.charCodeAt(0)), 0);
    await drop(page, bytes, 'unreadable.e57');

    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
    await expect(page.locator('.olv-toast-text')).not.toBeEmpty();
    await expect(page.locator('.olv-toast-context')).toBeHidden();
    await expect(page.locator('body > .olv-visually-hidden[role="alert"]')).not.toBeEmpty();
    await expect(page.locator('.olv-empty')).toBeVisible();
    expect((await polite(page)).some((s) => s.startsWith('Opened') || /ready/i.test(s))).toBe(false);
  });

  test('Cancel ends the open, clears the context and says so', async ({ page }) => {
    await page.goto('/');
    await installReadGate(page);
    await drop(page, TINY_LAS, 'cancel-me.las');
    await expect(page.locator('.olv-toast-text')).toContainText('Reading file');

    await page.locator('.olv-toast').getByRole('button', { name: 'Cancel loading' }).click();
    // The read in flight finishes; the cancel is honoured right after it.
    await page.evaluate(() => (window as unknown as { __olvReadGate: { open: () => void } }).__olvReadGate.open());
    await expect(page.locator('.olv-toast')).toBeHidden();
    await expect(page.locator('.olv-toast-context')).toBeHidden();
    await expect(politeText(page)).toHaveText('Cancelled opening cancel-me.las.');
    await expect(page.locator('.olv-empty')).toBeVisible();
  });

  test('a failure, then a retry that opens', async ({ page }) => {
    await page.goto('/');
    const broken = new Uint8Array(120);
    broken.set([0x4c, 0x41, 0x53, 0x46], 0);
    await drop(page, broken, 'broken.las');
    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
    await expect(page.locator('.olv-toast-context')).toBeHidden();

    await drop(page, TINY_LAS, 'retry.las');
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await expect(toast).toBeHidden({ timeout: 20_000 });
    await expect(toast).not.toHaveClass(/olv-toast-error/);
    await expect(politeText(page)).toContainText('retry.las');
  });

  for (const width of [360, 390, 768, 1024]) {
    test(`a long file name keeps Cancel on the card at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/');
      await installReadGate(page);
      const name = `${'Survey_Block_7_North_Ridge_Dense_Classified_'.repeat(5)}final.las`;
      await drop(page, TINY_LAS, name);
      await expect(page.locator('.olv-toast-text')).toContainText('Reading file');

      const m = await page.evaluate(() => {
        const toast = document.querySelector('.olv-toast')!.getBoundingClientRect();
        const file = document.querySelector<HTMLElement>('.olv-toast-file')!;
        const facts = document.querySelector('.olv-toast-facts')!.getBoundingClientRect();
        const cancel = document.querySelector('.olv-toast-cancel')!.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          toastLeft: toast.left, toastRight: toast.right,
          fileText: file.textContent, fileTruncated: file.scrollWidth > file.clientWidth,
          factsRight: facts.right,
          cancelLeft: cancel.left, cancelRight: cancel.right, cancelWidth: cancel.width,
          viewport: window.innerWidth,
        };
      });
      expect(m.overflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
      expect(m.toastLeft).toBeGreaterThanOrEqual(0);
      expect(m.toastRight).toBeLessThanOrEqual(m.viewport);
      expect(m.fileText).toBe(name);
      expect(m.fileTruncated, 'the long name is shortened on screen').toBe(true);
      expect(m.factsRight).toBeLessThanOrEqual(m.toastRight + 1);
      expect(m.cancelWidth).toBeGreaterThan(0);
      expect(m.cancelLeft).toBeGreaterThanOrEqual(m.toastLeft);
      expect(m.cancelRight).toBeLessThanOrEqual(m.toastRight + 1);
      await expect(page.locator('.olv-toast').getByRole('button', { name: 'Cancel loading' })).toBeInViewport();
      await page.evaluate(() => (window as unknown as { __olvReadGate: { open: () => void } }).__olvReadGate.open());
      await expect(page.locator('.olv-toast')).toBeHidden({ timeout: 20_000 });
    });
  }
});
