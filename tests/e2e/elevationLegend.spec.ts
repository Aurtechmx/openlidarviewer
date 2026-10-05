/**
 * elevationLegend.spec.ts
 *
 * The elevation colour legend: the ramp spans the card, the distribution
 * strip of the colouring sample sits above it with the clipped shares below,
 * and a probe hover over the canvas marks the hovered point's height and
 * percentile on the ramp.
 *
 * The scan is a synthesised positions-only PLY, which opens coloured by
 * height, so no colour-mode click is needed.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropHillsPly } from './helpers';

async function openLegend(page: Page) {
  await page.goto('/');
  await dropHillsPly(page);
  const legend = page.locator('.olv-colorbar');
  await expect(legend).toBeVisible({ timeout: 30_000 });
  await expect(legend.locator('.olv-colorbar-hist rect').first()).toBeAttached({ timeout: 10_000 });
  return legend;
}

/** Ramp width as a share of the card's content box. */
async function rampShare(page: Page): Promise<number> {
  return page.locator('.olv-colorbar').evaluate((card) => {
    const cs = getComputedStyle(card);
    const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ramp = card.querySelector('.olv-colorbar-ramp')!.getBoundingClientRect();
    return ramp.width / inner;
  });
}

test.describe('elevation legend', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('ramp spans the card, strip and clipped shares are present', async ({ page }) => {
    const legend = await openLegend(page);
    expect(await rampShare(page)).toBeGreaterThanOrEqual(0.9);
    const rampH = await legend.locator('.olv-colorbar-ramp').evaluate((r) => r.getBoundingClientRect().height);
    expect(rampH).toBeGreaterThanOrEqual(14);
    expect(await legend.locator('.olv-colorbar-hist rect').count()).toBeGreaterThan(10);
    const caps = legend.locator('.olv-colorbar-caps');
    await expect(caps).toBeVisible();
    await expect(caps).toContainText('below');
    await expect(caps).toContainText('above');
    // Decorative strip, summarised in the scale's accessible name.
    await expect(legend.locator('.olv-colorbar-hist')).toHaveAttribute('aria-hidden', 'true');
    await expect(legend.locator('.olv-colorbar-svg svg')).toHaveAttribute('aria-label', /Half the sampled points lie between .+ source units; .+ below .+ above/);
    // Unknown vertical unit: no unit is claimed on the endpoints.
    await expect(legend.locator('.olv-colorbar-range')).not.toContainText(' m');
    await expect(legend.locator('.olv-colorbar-marker')).toBeHidden();
  });

  test('a probe hover over the canvas marks the height and percentile', async ({ page }) => {
    const legend = await openLegend(page);
    await page.locator('.olv-dock .olv-tool', { hasText: 'Probe' }).click();
    const marker = legend.locator('.olv-colorbar-marker');
    const box = (await page.locator('.olv-canvas').boundingBox())!;
    // Sweep the pointer until the probe's pick lands on a point.
    for (let k = 0; k < 40 && !(await marker.isVisible()); k++) {
      const fx = 0.3 + 0.4 * ((k * 7) % 10) / 10;
      const fy = 0.3 + 0.4 * ((k * 3) % 10) / 10;
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 2 });
      await page.waitForTimeout(80);
    }
    await expect(marker).toBeVisible();
    await expect(legend.locator('.olv-colorbar-readout')).toHaveText(/^[\d.,-]+ source units · \d+(st|nd|rd|th) pct$/);
    // The readout is not a live region: nothing is announced per mouse move.
    await expect(legend.locator('[aria-live]')).toHaveCount(0);
  });

  test('reduced motion: the marker does not animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const legend = await openLegend(page);
    const duration = await legend
      .locator('.olv-colorbar-marker')
      .evaluate((m) => getComputedStyle(m).transitionDuration);
    // The app's global reduced-motion rule clamps durations to 0.01 ms.
    expect(duration.split(',').every((d) => parseFloat(d) <= 0.001)).toBe(true);
  });
});

test.describe('elevation legend on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the card fits the screen and the ramp spans it', async ({ page }) => {
    const legend = await openLegend(page);
    const b = (await legend.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(390);
    expect(await rampShare(page)).toBeGreaterThanOrEqual(0.9);
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollW).toBeLessThanOrEqual(390);
  });
});
