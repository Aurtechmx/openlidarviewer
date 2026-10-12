/**
 * hudSeat.spec.ts: floating hints, toasts and the result lane never overlap.
 *
 * The hold-Space hint shown while a tool is active and a bottom toast used to
 * land on the same line above the navigation row, and the latest-result card
 * started at the top of the stage whatever else was there. Each is now seated
 * clear of its neighbours (src/ui/hudSeat.ts); these checks read the painted
 * boxes after the seat settles.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, placeTestDistance } from './helpers';

interface Box { sel: string; x: number; y: number; r: number; b: number }

/** Painted boxes (laid out, visible, not transparent) for each selector. */
async function painted(page: Page, sels: readonly string[]): Promise<Box[]> {
  return page.evaluate((list) => list.flatMap((sel) => Array.from(document.querySelectorAll(sel)).flatMap((n) => {
    const s = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05 || r.width < 1 || r.height < 1) return [];
    return [{ sel, x: r.left, y: r.top, r: r.right, b: r.bottom }];
  })), sels as string[]);
}

/** Every pair of painted boxes that overlaps by more than a pixel. */
function overlaps(boxes: readonly Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const c = boxes[j];
      if (Math.min(a.r, c.r) - Math.max(a.x, c.x) > 1 && Math.min(a.b, c.b) - Math.max(a.y, c.y) > 1) out.push(`${a.sel} × ${c.sel}`);
    }
  }
  return out;
}

async function openScan(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForFunction(() => !!(window as unknown as { __OLV_TEST_API__?: unknown }).__OLV_TEST_API__);
}

const BOTTOM = ['.olv-nav-prompt-tool.olv-visible', '.olv-lasso-toast.olv-visible', '.olv-ati:not(.olv-hidden)', '.olv-navbar', '.olv-dock'];

for (const [w, h] of [[1280, 800], [768, 1024]] as const) {
  test(`${w}px: the hold-Space hint, a bottom toast, the tool pill and the dock stay apart`, async ({ page }) => {
    await openScan(page, w, h);
    await page.keyboard.press('m');
    await expect(page.locator('.olv-nav-prompt-tool.olv-visible')).toBeVisible();
    await expect(page.locator('.olv-ati.olv-ati-settled')).toBeVisible();
    await expect.poll(async () => overlaps(await painted(page, BOTTOM)), { timeout: 5_000 }).toEqual([]);
  });
}

test('1280px: the result card drops below the measure bar and a progress toast', async ({ page }) => {
  await openScan(page, 1280, 800);
  await page.keyboard.press('m');
  await placeTestDistance(page);
  const card = page.locator('.olv-result-card');
  await expect(card).toBeVisible({ timeout: 10_000 });
  // Bring the progress toast up over the lane, as a long task would.
  await page.evaluate(() => document.querySelector('.olv-toast:not(.olv-recovery-notice)')?.classList.remove('olv-hidden'));
  const top = ['.olv-result-card', '.olv-toast:not(.olv-hidden)', '.olv-measure-bar:not(.olv-hidden)'];
  await expect.poll(async () => (await painted(page, top)).length, { timeout: 5_000 }).toBe(3);
  await expect.poll(async () => overlaps(await painted(page, top)), { timeout: 5_000 }).toEqual([]);
});
