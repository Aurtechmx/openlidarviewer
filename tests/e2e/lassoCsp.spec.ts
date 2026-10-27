import { test, expect } from '@playwright/test';
import { dropHillsPly, waitForCameraSettled } from './helpers';

// The built page ships an enforcing CSP whose style-src has no
// 'unsafe-inline', so a `style` attribute written from script is dropped. The
// lasso overlay once set its box that way: it fell back to 300x150 at the top
// left and never saw the drag.
test('lasso overlay covers the canvas and draws under the enforcing CSP', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|violates the following/i.test(m.text())) cspErrors.push(m.text());
  });
  await page.goto('/?test=1');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp ?? '').toContain('style-src');
  expect(csp ?? '').not.toContain("'unsafe-inline'");

  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  await waitForCameraSettled(page);

  await page.keyboard.press('l');
  const svg = page.locator('svg.olv-lasso-svg');
  await expect(svg).toBeAttached({ timeout: 10_000 });

  const canvasBox = await page.locator('.olv-canvas').boundingBox();
  const svgBox = await svg.boundingBox();
  expect(canvasBox && svgBox).toBeTruthy();
  expect(Math.abs(svgBox!.width - canvasBox!.width)).toBeLessThan(2);
  expect(Math.abs(svgBox!.height - canvasBox!.height)).toBeLessThan(2);
  expect(await svg.evaluate((el) => getComputedStyle(el).cursor)).toBe('crosshair');

  const cx = canvasBox!.x + canvasBox!.width / 2;
  const cy = canvasBox!.y + canvasBox!.height / 2;
  const r = Math.min(canvasBox!.width, canvasBox!.height) * 0.2;
  await page.mouse.move(cx + r, cy);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a) * 0.9, { steps: 2 });
    if (i === 12) {
      const d = await svg.locator('path').getAttribute('d');
      expect((d ?? '').length).toBeGreaterThan(20);
    }
  }
  await page.mouse.up();
  expect(cspErrors).toEqual([]);
});
