import { test, expect, type Page, type Download } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropTerrainAccessUtmLas } from './helpers';

/**
 * Snapshot and image-export PNGs hold the scan, not an empty frame.
 *
 * A WebGL drawing buffer may be cleared once a frame is presented, and a WebGPU
 * canvas texture expires at the end of the task that rendered it. A capture
 * that renders, waits a frame and then reads the canvas can therefore read
 * nothing. Chromium does clear, so these run in the deterministic project.
 */

/** Pixels in the PNG that differ clearly from its top-left (background) pixel. */
async function scanPixels(page: Page, download: Download): Promise<{ width: number; differing: number }> {
  const b64 = readFileSync((await download.path())!).toString('base64');
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r0, g0, b0] = [px[0], px[1], px[2]];
    let differing = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 60) differing++;
    }
    return { width: c.width, differing };
  }, b64);
}

async function openScan(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?test=1');
  await dropTerrainAccessUtmLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
}

test('a saved snapshot holds scan pixels', async ({ page }) => {
  await openScan(page);
  const download = page.waitForEvent('download');
  await page.locator('.olv-tool-snapshot').dispatchEvent('click');
  const { width, differing } = await scanPixels(page, await download);
  expect(width).toBeGreaterThan(0);
  expect(differing, 'snapshot pixels that differ from the background').toBeGreaterThan(200);
});

test('a height-map image export holds scan pixels', async ({ page }) => {
  await openScan(page);
  await page.locator('.olv-ws-tab[data-mode="output"]').click();
  const button = page.locator('.olv-export-btn', { hasText: 'Height map' });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await button.dispatchEvent('click');
  const { differing } = await scanPixels(page, await download);
  expect(differing, 'height-map pixels that differ from the background').toBeGreaterThan(200);
});
