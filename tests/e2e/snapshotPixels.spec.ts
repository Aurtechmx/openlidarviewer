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
async function scanPixels(page: Page, download: Download, leftShare = 1): Promise<{ width: number; differing: number; opaque: number; total: number }> {
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
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 255) opaque++;
      if ((i / 4) % c.width >= maxX || px[i + 3] === 0) continue;
      if (Math.abs(px[i] - r0) + Math.abs(px[i + 1] - g0) + Math.abs(px[i + 2] - b0) > 60) differing++;
    }
    return { width: c.width, differing, opaque, total: c.width * c.height };
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

/** A height field with no colour channel, so it opens coloured by height. */
async function dropHeightField(page: Page): Promise<void> {
  const N = 70;
  const rows: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = i / (N - 1);
      const v = j / (N - 1);
      const h = 380 + 40 * Math.sin(u * 3.1) * Math.cos(v * 2.2) + 15 * u;
      rows.push(`${(u * 60 - 30).toFixed(3)} ${h.toFixed(3)} ${(v * 60 - 30).toFixed(3)}`);
    }
  }
  const text = `ply\nformat ascii 1.0\nelement vertex ${N * N}\nproperty float x\nproperty float y\nproperty float z\nend_header\n${rows.join('\n')}\n`;
  const dataTransfer = await page.evaluateHandle((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'hills.ply'));
    return dt;
  }, text);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

test('a snapshot with the colour bar burned in holds scan pixels left of the bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/?test=1');
  await dropHeightField(page);
  // Coloured by height: the legend shows, so the snapshot takes the composite path.
  await expect(page.locator('.olv-colorbar')).toBeVisible({ timeout: 30_000 });
  const download = page.waitForEvent('download');
  await page.locator('.olv-tool-snapshot').dispatchEvent('click');
  const r = await scanPixels(page, await download, 0.75);
  // An empty GL frame leaves the composite transparent apart from the bar.
  expect(r.opaque / r.total, 'share of opaque pixels in the composite snapshot').toBeGreaterThan(0.9);
  expect(r.differing, 'scan pixels left of the colour bar').toBeGreaterThan(200);
});

