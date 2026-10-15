import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isBenignPageError } from './pageErrors';
import { extractEntry, textOf } from '../helpers/zipReader';

/**
 * The georeferenced ortho export (PNG + .pgw + .prj) must describe the image it
 * ships: pixel size x image width equals the framed footprint, and the data's
 * bounding box lands on the image's content edges. A display with a device
 * pixel ratio above 1 is where the delivered PNG once came out larger than the
 * size the world file was computed for.
 */

const EPSG_UTM33N = 32633;
const OX = 500000;
const OY = 4100000;
const W_M = 120; // footprint width (m)
const H_M = 60; // footprint height (m)

async function gridLas(): Promise<number[]> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const nx = W_M + 1;
  const ny = H_M + 1;
  const n = nx * ny;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const colors = new Uint8Array(n * 3);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      x[k] = OX + i;
      y[k] = OY + j;
      z[k] = 100 + ((i + j) % 5);
      colors[k * 3] = 255;
      colors[k * 3 + 1] = 255;
      colors[k * 3 + 2] = 255;
    }
  }
  const wkt = wktForEpsg(EPSG_UTM33N)!;
  return [...writeLas14({ count: n, x, y, z, colors }, { wkt, epsg: EPSG_UTM33N, linearUnitCode: 9001 })];
}

async function dropBytes(page: Page, bytes: number[], name: string): Promise<void> {
  const dt = await page.evaluateHandle(({ b, n }) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], n));
    return d;
  }, { b: bytes, n: name });
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

test.use({ deviceScaleFactor: 1.5 });
test.setTimeout(120_000);

test('ortho export world file matches the PNG it ships (device pixel ratio 1.5)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await dropBytes(page, await gridLas(), 'utm33-grid.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });

  // White points (RGB) on the dark scene background make the data pixels easy
  // to tell from empty ones.
  await page.getByRole('button', { name: 'RGB', exact: true }).dispatchEvent('click');

  // Under a fractional device scale factor the rail tab's box never settles to
  // Playwright's "stable" check, so the tab is activated by its click event.
  await page.locator('.olv-ws-tab[data-mode="output"]').dispatchEvent('click');
  const section = page.locator('details.olv-section-collapsible', { has: page.locator('summary', { hasText: 'Image export' }) });
  await section.evaluate((d) => { (d as HTMLDetailsElement).open = true; });
  const button = section.getByRole('button', { name: 'View capture' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  // Keep the live render loop drawing while the export renders, as a moving
  // pointer does: the loop's frames are what once re-applied the display pixel
  // ratio to the export-sized drawing buffer.
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const tick = (): void => {
      canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: 200 + Math.random(), clientY: 200, bubbles: true }));
      requestAnimationFrame(tick);
    };
    tick();
  });
  const downloadPromise = page.waitForEvent('download');
  await button.dispatchEvent('click');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/orthographic-rgb\.zip$/);
  const zip = new Uint8Array(readFileSync((await download.path())!));
  const base = download.suggestedFilename().replace(/\.zip$/, '');
  const png = extractEntry(zip, `${base}.png`);
  expect(png).not.toBeNull();
  const pgw = textOf(zip, `${base}.pgw`).trim().split('\n').map(Number);
  const dv = new DataView(png!.buffer, png!.byteOffset, png!.byteLength);
  const widthPx = dv.getUint32(16);
  const heightPx = dv.getUint32(20);

  const [a, , , e, c, f] = pgw as [number, number, number, number, number, number];
  // Pixel size x delivered width = the framed footprint.
  expect(a * widthPx).toBeCloseTo(W_M, 3);
  expect(-e * heightPx).toBeCloseTo(H_M, 3);
  // Upper-left pixel centre sits half a pixel inside the footprint corner.
  expect(c - a / 2).toBeCloseTo(OX, 3);
  expect(f - e / 2).toBeCloseTo(OY + H_M, 3);

  // Content edges: the data pixels span the whole raster.
  const stats = await page.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const cv = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let yy = 0; yy < bmp.height; yy++) {
      for (let xx = 0; xx < bmp.width; xx++) {
        const i = (yy * bmp.width + xx) * 4;
        const lit = d[i]! > 128 && d[i + 1]! > 128 && d[i + 2]! > 128 && d[i + 3]! > 128;
        if (!lit) continue;
        if (xx < minX) minX = xx;
        if (yy < minY) minY = yy;
        if (xx > maxX) maxX = xx;
        if (yy > maxY) maxY = yy;
      }
    }
    return { w: bmp.width, h: bmp.height, minX, minY, maxX, maxY };
  }, [...png!]);
  expect(stats.w).toBe(widthPx);
  // The grid's outer rows/columns of points sit on the footprint edge, so lit
  // pixels reach within a few pixels of every image edge.
  const tol = Math.ceil(stats.w / W_M) + 3;
  expect(stats.minX).toBeLessThanOrEqual(tol);
  expect(stats.minY).toBeLessThanOrEqual(tol);
  expect(stats.maxX).toBeGreaterThanOrEqual(stats.w - 1 - tol);
  expect(stats.maxY).toBeGreaterThanOrEqual(stats.h - 1 - tol);
  expect(errors).toEqual([]);
});
