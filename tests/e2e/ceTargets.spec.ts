/**
 * ceTargets.spec.ts: the controls this release adds or relabels are big
 * enough to hit (COMMUNITY_SPEC.md §11.1, PRINCIPLES.md accessibility).
 *
 * At least 24 by 24 CSS px everywhere (WCAG 2.2 success criterion 2.5.8,
 * level AA). On a touch viewport the house target is 44 by 44 CSS px; that
 * size matches criterion 2.5.5, which is level AAA, and no AAA conformance is
 * claimed.
 *
 * Controls covered (C1): the dock buttons, whose labels now come from the
 * action registry; the NavBar frame button and camera chips, whose names now
 * come from the registry; the canvas menu rows; the empty state's Open scan
 * and the Measure panel's Export session.
 */
import { test, expect, type Locator, type Page } from '@playwright/test';
import { dropDenseGridPly, pinNavigationPanel, placeTestDistance } from './helpers';

const AA = 24;
const TOUCH = 44;

/** The rendered size of every visible match, with a readable name for failures. */
async function sizes(scope: Locator): Promise<Array<{ name: string; w: number; h: number }>> {
  return scope.evaluateAll((nodes) => nodes
    .filter((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    })
    .map((n) => {
      const r = n.getBoundingClientRect();
      const name = n.getAttribute('aria-label') ?? n.textContent?.trim() ?? n.className;
      return { name, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    }));
}

function expectAtLeast(list: Array<{ name: string; w: number; h: number }>, min: number, what: string): void {
  expect(list.length, `no ${what} visible`).toBeGreaterThan(0);
  const small = list.filter((s) => s.w < min || s.h < min);
  expect(small, `${what} under ${min}x${min} CSS px`).toEqual([]);
}

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
}

test.describe('targets at desktop size', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('empty state Open scan', async ({ page }) => {
    await page.goto('/?test=1');
    expectAtLeast(await sizes(page.locator('.olv-open-btn')), AA, 'Open scan');
  });

  test('dock, NavBar and canvas menu controls', async ({ page }) => {
    await pinNavigationPanel(page);
    await openScan(page);
    await expect(page.locator('.olv-dock [data-action="tool.measure"]')).toBeEnabled({ timeout: 20_000 });
    expectAtLeast(await sizes(page.locator('.olv-dock [data-action]')), AA, 'dock buttons');
    expectAtLeast(await sizes(page.locator('.olv-navbar .olv-mode-reset')), AA, 'NavBar Frame all');
    expectAtLeast(await sizes(page.locator('.olv-navbar .olv-cam-chip')), AA, 'NavBar camera chips');

    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(page.locator('.olv-ctxmenu')).toBeVisible();
    expectAtLeast(await sizes(page.locator('.olv-ctxmenu-item')), AA, 'canvas menu rows');
    await page.keyboard.press('Escape');
  });

  test('Measure panel Export session', async ({ page }) => {
    await openScan(page);
    await page.locator('.olv-dock [data-action="tool.measure"]').click();
    await placeTestDistance(page);
    expectAtLeast(await sizes(page.locator('.olv-mp-action', { hasText: 'Export session' })), AA, 'Export session');
    // The registry name keeps one line: the button is no taller than its one-word neighbour.
    const heights = await page.locator('.olv-mp-action').evaluateAll((n) => n.map((e) => [e.textContent?.trim(), e.getBoundingClientRect().height] as const));
    const open = heights.find(([t]) => t === 'Open')![1];
    expect(heights.find(([t]) => t === 'Export session')![1]).toBeLessThanOrEqual(open);
  });
});

test.describe('targets on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('empty state Open scan', async ({ page }) => {
    await page.goto('/?test=1');
    expectAtLeast(await sizes(page.locator('.olv-open-btn')), TOUCH, 'Open scan');
  });

  test('dock buttons', async ({ page }) => {
    await openScan(page);
    await expect(page.locator('.olv-dock [data-action="tool.measure"]')).toBeEnabled({ timeout: 20_000 });
    expectAtLeast(await sizes(page.locator('.olv-dock [data-action]')), TOUCH, 'dock buttons');
  });

  test('Measure panel Export session', async ({ page }) => {
    await openScan(page);
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    await page.locator('.olv-msheet-slot[data-tab="work"] .olv-tl-row', { hasText: 'Measure' }).click();
    await placeTestDistance(page);
    await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    const button = page.locator('.olv-mp-action', { hasText: 'Export session' });
    await button.scrollIntoViewIfNeeded();
    expectAtLeast(await sizes(button), TOUCH, 'Export session');
  });
});
