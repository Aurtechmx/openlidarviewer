import { test, expect, type Page, type Download } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropHillsPly, dropTerrainAccessUtmLas } from './helpers';

/**
 * Snapshot and image-export PNGs hold the scan, not an empty frame.
 *
 * A WebGL drawing buffer may be cleared once a frame is presented, and a WebGPU
 * canvas texture expires at the end of the task that rendered it. A capture
 * that renders, waits a frame and then reads the canvas can therefore read
 * nothing. Chromium does clear, so these run in the deterministic project.
 */

/** Pixels in the PNG that differ clearly from its top-left (background) pixel. */
async function scanPixels(page: Page, download: Download, leftShare = 1): Promise<{ width: number; differing: number; opaque: number; translucent: number; total: number }> {
  const b64 = readFileSync((await download.path())!).toString('base64');
  return page.evaluate(async ([data, share]) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const [r0, g0, b0] = [px[0], px[1], px[2]];
    // Only columns left of `share` count, so a burned-in colour bar on the
    // right edge cannot stand in for scan pixels.
    const maxX = Math.floor(c.width * (share as number));
    let differing = 0;
    let opaque = 0;
    let translucent = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 255) opaque++;
      else translucent++;
      if ((i / 4) % c.width >= maxX || px[i + 3] === 0) continue;
      if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 60) differing++;
    }
    return { width: c.width, differing, opaque, translucent, total: c.width * c.height };
  }, [b64, leftShare] as const);
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
  const { width, differing, translucent } = await scanPixels(page, await download);
  expect(width).toBeGreaterThan(0);
  // Point blending leaves partial alpha in Chromium's drawing buffer; the PNG is opaque in every engine.
  expect(translucent, 'snapshot pixels with alpha below 255').toBe(0);
  expect(differing, 'snapshot pixels that differ from the background').toBeGreaterThan(200);
});

test('a height-map image export holds scan pixels', async ({ page }) => {
  await openScan(page);
  await page.locator('.olv-ws-tab[data-mode="output"]').click();
  const button = page.locator('.olv-export-btn', { hasText: 'Height map' });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await button.dispatchEvent('click');
  const { differing, translucent } = await scanPixels(page, await download);
  expect(translucent, 'height-map pixels with alpha below 255').toBe(0);
  expect(differing, 'height-map pixels that differ from the background').toBeGreaterThan(200);
});

test('a snapshot with the colour bar burned in holds scan pixels left of the bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?test=1');
  await dropHillsPly(page);
  // Coloured by height: the legend shows, so the snapshot takes the composite path.
  await expect(page.locator('.olv-colorbar')).toBeVisible({ timeout: 30_000 });
  const download = page.waitForEvent('download');
  await page.locator('.olv-tool-snapshot').dispatchEvent('click');
  const r = await scanPixels(page, await download, 0.75);
  // An empty GL frame leaves the composite transparent apart from the bar.
  expect(r.translucent, 'composite snapshot pixels with alpha below 255').toBe(0);
  expect(r.opaque / r.total, 'share of opaque pixels in the composite snapshot').toBeGreaterThan(0.9);
  expect(r.differing, 'scan pixels left of the colour bar').toBeGreaterThan(200);
});


/**
 * Some engines report partial alpha for the WebGL canvas when it is drawn into
 * a 2-D canvas (point blending leaves it in the drawing buffer), which is how an
 * exported PNG ended up with translucent pixels around the points. This makes
 * every engine do that: the drawing buffer is copied at half alpha. The export
 * has to come out opaque anyway.
 */
async function reportHalfAlphaForGlCopies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage as (...a: unknown[]) => void;
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      const src = args[0];
      const live = src instanceof HTMLCanvasElement && src.isConnected;
      const before = this.globalAlpha;
      if (live) this.globalAlpha = 0.5;
      try {
        draw.apply(this, args);
      } finally {
        this.globalAlpha = before;
      }
    } as typeof CanvasRenderingContext2D.prototype.drawImage;
  });
}

test('a snapshot is opaque when the engine reports partial alpha for the GL canvas', async ({ page }) => {
  await reportHalfAlphaForGlCopies(page);
  await openScan(page);
  const download = page.waitForEvent('download');
  await page.locator('.olv-tool-snapshot').dispatchEvent('click');
  const r = await scanPixels(page, await download);
  expect(r.translucent, 'snapshot pixels with alpha below 255').toBe(0);
});

test('a height-map export is opaque when the engine reports partial alpha for the GL canvas', async ({ page }) => {
  await reportHalfAlphaForGlCopies(page);
  await openScan(page);
  await page.locator('.olv-ws-tab[data-mode="output"]').click();
  const button = page.locator('.olv-export-btn', { hasText: 'Height map' });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  const download = page.waitForEvent('download');
  await button.dispatchEvent('click');
  const r = await scanPixels(page, await download);
  expect(r.translucent, 'height-map pixels with alpha below 255').toBe(0);
});
