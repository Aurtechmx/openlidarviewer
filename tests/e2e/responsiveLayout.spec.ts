import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * Wait until a resize's layout has settled instead of sleeping a fixed
 * duration: poll `document.documentElement.scrollWidth` until two
 * consecutive animation frames read the same value. A literal timeout is a
 * timing assumption a loaded CI runner or a slower engine (WebKit, Firefox)
 * can miss; this instead waits for the actual condition the sweep needs —
 * nothing still reflowing — however long that takes.
 */
async function waitForLayoutStable(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const before = document.documentElement.scrollWidth;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(document.documentElement.scrollWidth === before);
          });
        });
      }),
    undefined,
    { timeout: 5_000 },
  );
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
      await waitForLayoutStable(page);
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
      await waitForLayoutStable(page);
      await assertNoOverflowOrClipping(page, `tour open @ ${width}px`);
    }
  });
});

test.describe('responsive layout — findings the generic sweep cannot trigger', () => {
  // OVERLAYS-TOAST-1 / INTAKE-F5: the DropZone toast's Cancel control ran
  // past the card edge on an unbroken long filename. `dropTinyLas` (used by
  // the sweep above) drops `tiny.las` — 8 characters, nowhere near the
  // ~50-90+ char threshold that actually triggers the overflow — so this
  // gets its own drop with a synthesised long name.
  test('the DropZone toast wraps an unbroken long filename instead of pushing Cancel off the card', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: HEIGHT });
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    const bytes = readFileSync(
      fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)),
    );
    // 90 unbroken characters, no delimiters — matches the fix's own
    // reproduction threshold.
    const longName = `${'a'.repeat(90)}.las`;

    // Drop and read the toast in ONE evaluate call: `DropZone.setOpening`
    // runs synchronously, before openScan's first await, so reading in the
    // same task as the dispatch guarantees nothing has superseded the
    // "Opening <name>…" toast yet — no `waitForTimeout` race to get right.
    const measured = await page.evaluate(
      ({ bytes: raw, name }) => {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(new File([new Uint8Array(raw)], name));
        document.body.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }),
        );
        const toast = document.querySelector('.olv-toast') as HTMLElement;
        const text = document.querySelector('.olv-toast-text') as HTMLElement;
        const cancel = document.querySelector('.olv-toast-cancel') as HTMLElement;
        return {
          toastText: text.textContent ?? '',
          toastRight: toast.getBoundingClientRect().right,
          textScrollWidth: text.scrollWidth,
          textClientWidth: text.clientWidth,
          cancelRight: cancel.getBoundingClientRect().right,
        };
      },
      { bytes: [...bytes], name: longName },
    );

    expect(measured.toastText, 'the toast never showed the dropped filename').toContain(longName);
    // Wrapping keeps the text's own scrollWidth at or below its clientWidth;
    // an unbroken word that cannot wrap instead forces scrollWidth wider.
    expect(
      measured.textScrollWidth,
      `the filename forced the text ${measured.textScrollWidth}px wide, wider than its ${measured.textClientWidth}px box, instead of wrapping`,
    ).toBeLessThanOrEqual(measured.textClientWidth + 1);
    expect(
      measured.cancelRight,
      `Cancel (right=${measured.cancelRight}) ran past the toast card (right=${measured.toastRight})`,
    ).toBeLessThanOrEqual(measured.toastRight + 1);
  });

  // CRITIC-GAP-3: the phone Inspector layer row's isolate/lock buttons had
  // no explicit touch-target floor, rendering at their glyph's natural
  // ~12-15px box instead of the 44px `.olv-layer-x` beside them already got.
  test('the phone Layers sheet grows isolate/lock to a 44px touch target', async ({ page }) => {
    test.slow();
    await page.setViewportSize({ width: 375, height: HEIGHT });
    await page.goto('/');
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    // The layer row lives in the phone "Layers" mobile sheet tab, not the
    // Inspector's own "Scan Info" bottom sheet — the two are separate
    // components (src/ui/Inspector.ts's addCloud rows render inside the
    // Layers mobile sheet).
    await page.locator('.olv-msheet-tab', { hasText: 'Layers' }).click();

    const solo = page.locator('.olv-layer-solo').first();
    const lock = page.locator('.olv-layer-lock').first();
    await expect(solo).toBeVisible();
    await expect(lock).toBeVisible();

    const soloBox = await solo.boundingBox();
    const lockBox = await lock.boundingBox();
    expect(soloBox, 'isolate button has a layout box').not.toBeNull();
    expect(lockBox, 'lock button has a layout box').not.toBeNull();
    expect(soloBox!.width, 'isolate button width').toBeGreaterThanOrEqual(44);
    expect(soloBox!.height, 'isolate button height').toBeGreaterThanOrEqual(44);
    expect(lockBox!.width, 'lock button width').toBeGreaterThanOrEqual(44);
    expect(lockBox!.height, 'lock button height').toBeGreaterThanOrEqual(44);
  });
});
