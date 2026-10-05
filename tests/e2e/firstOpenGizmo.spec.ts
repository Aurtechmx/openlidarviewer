/**
 * firstOpenGizmo.spec.ts: on first open the navigation widget stays off the scan.
 *
 * The opening fit used to fill the whole canvas, so the bottom-centre mode
 * triangle (and, for a first-time user, the Navigation panel stacked above it)
 * sat on the middle of the freshly framed cloud. The fit now keeps the scan
 * above the triangle, and the panel starts closed.
 *
 * The cloud's projected box is read from pixels: every overlay is hidden for
 * one screenshot of the bare canvas, and the box is the extent of the pixels
 * brighter than the background. The gizmo's box is the mode triangle's row.
 * At phone width the bar does not lay out at all, which passes trivially and
 * is asserted as such.
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

interface Box { x: number; y: number; w: number; h: number }

/** The bright-pixel extent of the bare canvas, in CSS pixels. */
async function cloudBox(page: Page): Promise<Box | null> {
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.tagName === 'CANVAS' || el.querySelector('canvas')) continue;
      el.dataset.e2eVis = el.style.visibility;
      el.style.visibility = 'hidden';
    }
  });
  const png = await page.screenshot();
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-e2e-vis]'))) {
      el.style.visibility = el.dataset.e2eVis ?? '';
      delete el.dataset.e2eVis;
    }
  });
  return page.evaluate(async (bytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (Math.max(data[i], data[i + 1], data[i + 2]) <= 60) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    const k = c.width / window.innerWidth;
    return { x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k };
  }, [...png]);
}

/** The mode triangle's row, or null when the bar does not lay out. */
async function gizmoBox(page: Page): Promise<Box | null> {
  return page.evaluate(() => {
    const row = document.querySelector('.olv-navbar .olv-nav-row');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
}

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

for (const vp of [{ width: 1280, height: 800 }, { width: 375, height: 812 }]) {
  test(`first open at ${vp.width}x${vp.height}: the navigation gizmo does not cover the framed cloud`, async ({ page }) => {
    test.slow();
    await page.setViewportSize(vp);
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
    // The opening glide is 0.9 s and the bar's rise-in is shorter; let both finish.
    await page.waitForTimeout(2500);

    // The Navigation panel is help and starts closed.
    await expect(page.locator('.olv-nav-hud')).toBeHidden();

    const cloud = await cloudBox(page);
    expect(cloud, 'the framed cloud is drawn').not.toBeNull();
    const gizmo = await gizmoBox(page);
    if (vp.width < 768) {
      expect(gizmo, 'the navigation bar does not lay out on a phone').toBeNull();
      return;
    }
    expect(gizmo, 'the navigation bar lays out on desktop').not.toBeNull();
    expect(
      overlap(cloud!, gizmo!),
      `cloud ${JSON.stringify(cloud)} vs gizmo ${JSON.stringify(gizmo)}`,
    ).toBe(0);
  });
}
