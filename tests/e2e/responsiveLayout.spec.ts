import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas } from './helpers';

/**
 * responsiveLayout.spec.ts — the v0.7 layout-lane audit's own regression
 * gate.
 *
 * Six findings shared one root cause: a surface that read fine at the
 * project's usual widths broke at one it hadn't been checked at — the
 * Open-from-URL row at 320px, the onboarding tour card at 320-375px, the
 * tool dock clipping Close at 768px, the coordinate HUD under the dock at
 * every desktop width, the DropZone toast overflowing on a long filename,
 * and the scan-type segment clipping mid-word. Each got its own targeted
 * fix and CSS-source regression pin (tests/responsiveLayoutStyles.test.ts);
 * this spec is the standing width sweep those fixes came out of, run at
 * every width this project treats as load-bearing (320/375 phone, 768 the
 * desktop-layer edge, 1280 a full desktop) across the three states most
 * likely to expose a new one: the empty state, a loaded scan, and the tour.
 */

const WIDTHS = [320, 375, 768, 1280] as const;
const HEIGHT = 900;

/** Chrome-level controls the audit's findings live on — not panel-internal
 * rows, which have their own scroll containers and are out of this spec's
 * scope. */
const CHROME_SELECTOR = [
  '.olv-topbar button',
  '.olv-topbar a',
  '.olv-url-input',
  '.olv-url-btn',
  '.olv-catalog-select',
  '.olv-catalog-btn',
  '.olv-sample',
  '.olv-tour-chip',
  '.olv-open-btn',
  '.olv-tool',
  '.olv-navbar button',
  '.olv-tour-card button',
  '.olv-tour-skip',
].join(', ');

interface Overflow {
  scrollWidth: number;
  clientWidth: number;
}

interface ClippedControl {
  tag: string;
  cls: string;
  left: number;
  right: number;
}

async function readOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

async function readClippedControls(page: Page, selector: string): Promise<ClippedControl[]> {
  return page.evaluate((sel) => {
    const vw = window.innerWidth;
    const out: { tag: string; cls: string; left: number; right: number }[] = [];
    document.querySelectorAll(sel).forEach((el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.left < -1 || r.right > vw + 1) {
        out.push({
          tag: el.tagName,
          cls: (el.className && el.className.toString()) || '',
          left: Math.round(r.left * 10) / 10,
          right: Math.round(r.right * 10) / 10,
        });
      }
    });
    return out;
  }, selector);
}

/** Assert both invariants at the page's CURRENT viewport. */
async function assertNoOverflowOrClipping(page: Page, when: string): Promise<void> {
  const { scrollWidth, clientWidth } = await readOverflow(page);
  expect(
    scrollWidth,
    `${when}: page scrolls horizontally (scrollWidth ${scrollWidth} > clientWidth ${clientWidth})`,
  ).toBeLessThanOrEqual(clientWidth + 1);

  const clipped = await readClippedControls(page, CHROME_SELECTOR);
  expect(
    clipped,
    `${when}: controls run past the viewport edge:\n${clipped
      .map((c) => `  ${c.tag}.${c.cls.split(' ')[0]} left=${c.left} right=${c.right}`)
      .join('\n')}`,
  ).toEqual([]);
}

test.describe('responsive layout — no overflow, no clipped controls', () => {
  test('the empty state holds at every width', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await assertNoOverflowOrClipping(page, `empty state @ ${width}px`);
    }
  });

  test('a loaded scan holds at every width', async ({ page }) => {
    test.slow();
    await page.goto('/');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      // The dock's own fold/unfold reflow needs a beat after the resize.
      await page.waitForTimeout(50);
      await assertNoOverflowOrClipping(page, `scan loaded @ ${width}px`);
    }
  });

  test('the onboarding tour holds at every width', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-tour-chip').click();
    await expect(page.locator('.olv-tour-card')).not.toHaveClass(/olv-hidden/, { timeout: 5_000 });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.waitForTimeout(50);
      await assertNoOverflowOrClipping(page, `tour open @ ${width}px`);
    }
  });
});
