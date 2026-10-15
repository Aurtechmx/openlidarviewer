import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { isBenignPageError } from './pageErrors';
import { extractEntry, textOf } from '../helpers/zipReader';

/**
 * The georeferenced ortho PNG marks no-data pixels transparent: a grid with a
 * rectangular hole exports with alpha 0 inside the hole, alpha 255 at every
 * point, no alpha in between, and the planned raster size the world file was
 * computed for. Runs on the page's default backend and on forced WebGL 2.
 */

const EPSG_UTM33N = 32633;
const OX = 500000;
const OY = 4100000;
const W_M = 40; // footprint width (m)
const H_M = 20; // footprint height (m)
const STEP = 0.25; // grid spacing (m)
// The hole: no points strictly inside this rectangle (local metres).
const HOLE = { minX: 10, maxX: 20, minY: 5, maxY: 15 };
// Inside the hole by this margin, every pixel must be transparent.
const HOLE_MARGIN = 1;

async function gridWithHoleLas(): Promise<number[]> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const nx = Math.round(W_M / STEP) + 1;
  const ny = Math.round(H_M / STEP) + 1;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const lx = i * STEP;
      const ly = j * STEP;
      if (lx > HOLE.minX && lx < HOLE.maxX && ly > HOLE.minY && ly < HOLE.maxY) continue;
      xs.push(lx);
      ys.push(ly);
    }
  }
  const n = xs.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  const colors = new Uint8Array(n * 3).fill(255);
  for (let k = 0; k < n; k++) {
    x[k] = OX + xs[k]!;
    y[k] = OY + ys[k]!;
    z[k] = 100 + (k % 3) * 0.1;
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

test.setTimeout(120_000);

for (const backend of ['default', 'webgl2'] as const) {
  test(`ortho export marks no-data transparent (${backend} backend)`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

    await page.goto(backend === 'webgl2' ? '/?backend=webgl2' : '/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await dropBytes(page, await gridWithHoleLas(), 'utm33-hole.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    info.annotations.push({
      type: 'backend',
      description: (await page.locator('.olv-backend-text').first().textContent().catch(() => null))?.trim() ?? 'unknown',
    });
    await page.getByRole('button', { name: 'RGB', exact: true }).dispatchEvent('click');

    await page.locator('.olv-ws-tab[data-mode="output"]').dispatchEvent('click');
    const section = page.locator('details.olv-section-collapsible', { has: page.locator('summary', { hasText: 'Image export' }) });
    await section.evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    const button = section.getByRole('button', { name: 'View capture' });
    await expect(button).toBeEnabled({ timeout: 20_000 });
    const downloadPromise = page.waitForEvent('download');
    await button.dispatchEvent('click');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/orthographic-rgb\.zip$/);
    const zip = new Uint8Array(readFileSync((await download.path())!));
    const base = download.suggestedFilename().replace(/\.zip$/, '');
    const png = extractEntry(zip, `${base}.png`)!;
    expect(png).not.toBeNull();

    // The PNG carries the planned size: pixel size x width = the footprint.
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    const widthPx = dv.getUint32(16);
    const heightPx = dv.getUint32(20);
    const [a, , , e] = textOf(zip, `${base}.pgw`).trim().split('\n').map(Number) as [number, number, number, number];
    expect(a * widthPx).toBeCloseTo(W_M, 3);
    expect(-e * heightPx).toBeCloseTo(H_M, 3);
    // Colour type 6 (RGBA): the alpha channel is in the file.
    expect(png[25]).toBe(6);

    // The PNG says how no-data is encoded.
    const { readPngTextChunks } = await import('../../src/export/pngTextChunks');
    expect(readPngTextChunks(png).find((t) => t.keyword === 'olv:nodata')?.text).toMatch(/alpha 0/);

    const pxPerM = widthPx / W_M;
    const result = await page.evaluate(async ({ bytes, hole, margin, step, wM, hM, pxPerM }) => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }), {
        premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      });
      const cv = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = cv.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const alphaAt = (px: number, py: number): number => d[(py * bmp.width + px) * 4 + 3]!;
      let partial = 0;
      let transparent = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] === 0) transparent++;
        else if (d[i] !== 255) partial++;
      }
      // Every pixel inside the hole (with a margin) is transparent.
      let holeOpaque = 0;
      let holePixels = 0;
      const toPx = (lx: number): number => Math.floor(lx * pxPerM);
      const toPy = (ly: number): number => Math.floor((hM - ly) * pxPerM);
      for (let py = toPy(hole.maxY - margin); py <= toPy(hole.minY + margin); py++) {
        for (let px = toPx(hole.minX + margin); px <= toPx(hole.maxX - margin); px++) {
          holePixels++;
          if (alphaAt(px, py) !== 0) holeOpaque++;
        }
      }
      // Every interior grid point outside the hole lands on opaque white
      // pixels. A point centre can sit exactly on a pixel corner, and engines
      // round that differently, so the 2x2 pixels around the centre are read.
      let points = 0;
      let pointMisses = 0;
      const opaqueWhite = (px: number, py: number): boolean => {
        const i = (py * bmp.width + px) * 4;
        return d[i + 3] === 255 && d[i]! >= 128 && d[i + 1]! >= 128 && d[i + 2]! >= 128;
      };
      for (let ly = 1; ly <= hM - 1; ly += step) {
        for (let lx = 1; lx <= wM - 1; lx += step) {
          if (lx >= hole.minX && lx <= hole.maxX && ly >= hole.minY && ly <= hole.maxY) continue;
          points++;
          const px0 = Math.floor(lx * pxPerM - 0.5);
          const py0 = Math.floor((hM - ly) * pxPerM - 0.5);
          const hit = opaqueWhite(px0, py0) || opaqueWhite(px0 + 1, py0)
            || opaqueWhite(px0, py0 + 1) || opaqueWhite(px0 + 1, py0 + 1);
          if (!hit) pointMisses++;
        }
      }
      return { w: bmp.width, h: bmp.height, partial, transparent, holeOpaque, holePixels, points, pointMisses };
    }, { bytes: [...png], hole: HOLE, margin: HOLE_MARGIN, step: STEP, wM: W_M, hM: H_M, pxPerM });

    expect([result.w, result.h]).toEqual([widthPx, heightPx]);
    expect(result.partial, 'no semi-transparent pixels').toBe(0);
    expect(result.holePixels).toBeGreaterThan(1000);
    expect(result.holeOpaque, 'hole pixels with alpha above 0').toBe(0);
    expect(result.points).toBeGreaterThan(1000);
    expect(result.pointMisses, 'grid points whose pixel is not opaque white').toBe(0);
    expect(errors).toEqual([]);
  });
}
