import { test, expect, type Page } from '@playwright/test';
import { dropTinyLas, dropTinyPly, showWorkspaceMode } from './helpers';
import { fileURLToPath } from 'node:url';

/**
 * inspectAnnouncements.spec.ts
 *
 * End-to-end coverage for the "inspect" lane's accessibility fixes, driven
 * against the real production build rather than a fake DOM:
 *
 *   - INSP-1: the Classes legend's filter banner is announced through the
 *     app's shared polite live region, not a locally-toggled role="status"
 *     that display:none defeats.
 *   - INSP-4: the layer lock button's accessible name and aria-pressed flip
 *     with the locked state, and it is keyboard-activatable.
 *   - INSP-3 / INSP-6: "+ New group" survives a fast double click as one
 *     group, not two.
 *   - INSP-5: the recommended-view chip's auto-hide timer pauses on a real
 *     mouse hover — a browser-level event (mouseenter/mouseleave) a fake DOM
 *     cannot exercise.
 *   - CRITIC-GAP-2: the Inspect tool's Copy action confirms through the
 *     shared live region, not only a fading, unannounced note.
 *
 * The unit suites (classLegendLiveAnnounce, inspectorLayerLock,
 * inspectorNewGroup, recommendedViewChipTiming, inspectCopyAnnounce) pin the
 * same behaviour's logic with fake timers and a recording DOM stub; this
 * file is the live-browser confirmation that the wiring actually reaches a
 * real page.
 */

const LIVE_REGION = '.olv-visually-hidden[role="status"]';

async function liveRegionText(page: Page): Promise<string> {
  return page.locator(LIVE_REGION).first().textContent().then((t) => t ?? '');
}

test('hiding a class announces the filter banner through the shared live region', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyLas(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  const legend = page.locator('.olv-class-panel');
  await expect(legend).toBeVisible({ timeout: 20_000 });

  const rows = legend.locator('.olv-cl-row');
  const total = await rows.count();
  expect(total).toBeGreaterThan(1);

  await rows.first().locator('.olv-cl-check').uncheck();

  const banner = legend.locator('.olv-cl-banner');
  const expected = `Filtered — showing ${total - 1} of ${total} classes`;
  await expect(banner).toHaveText(expected);
  // The same text reaches the app's one shared live region — a screen
  // reader's actual announcement channel, not just the visible caption.
  await expect(page.locator(LIVE_REGION)).toHaveText(expected);
});

test('the layer lock button flips its accessible name and pressed state, and is keyboard-activatable', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'data');

  const lock = page.locator('.olv-layer-lock').first();
  await expect(lock).toBeVisible({ timeout: 10_000 });
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  const unlockedLabel = await lock.getAttribute('aria-label');
  expect(unlockedLabel).toMatch(/^Lock /);

  // Keyboard activation, not a mouse click — Enter on a focused button.
  await lock.focus();
  await lock.press('Enter');

  await expect(lock).toHaveAttribute('aria-pressed', 'true');
  const lockedLabel = await lock.getAttribute('aria-label');
  expect(lockedLabel).toMatch(/is locked/);
  expect(lockedLabel).not.toBe(unlockedLabel);

  await lock.press('Enter');
  await expect(lock).toHaveAttribute('aria-pressed', 'false');
  await expect(lock).toHaveAttribute('aria-label', unlockedLabel!);
});

test('"+ New group", double-clicked fast, creates exactly one group', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await showWorkspaceMode(page, 'data');

  // "+ Add dataset" also carries `.olv-group-new`; exclude it by its own
  // class rather than by text, which the pending state below rewrites.
  const newGroup = page.locator('.olv-group-new:not(.olv-add-dataset-row)');
  await expect(newGroup).toBeVisible({ timeout: 10_000 });

  // Playwright's own `.click()` waits for the button to be actionable
  // (enabled) between calls, which would just serialise two deliberate
  // clicks around the pending state rather than reproduce the race — two
  // clicks landing in the same synchronous turn, before the lazy import
  // has any chance to resolve. `elementHandle.click()` inside the page
  // dispatches the native click twice back to back, with nothing awaited
  // in between, which is the exact race INSP-6 describes.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll<HTMLButtonElement>('.olv-group-new')).find(
      (b) => !b.classList.contains('olv-add-dataset-row'),
    );
    btn?.click();
    btn?.click();
  });

  await expect(page.locator('.olv-group-head')).toHaveCount(1, { timeout: 10_000 });
  // The button is usable again once the (single) group finished creating.
  await expect(newGroup).toBeEnabled();
});

test.describe('recommended-view chip — hover pauses the auto-hide', () => {
  test.slow();

  test('stays visible past its 9s timer while genuinely hovered', async ({ page }) => {
    const fixture = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(fixture);
    const card = page.locator('.olv-project-card');
    await expect(card).toHaveClass(/olv-visible/, { timeout: 60_000 });
    await page.locator('.olv-pc-dismiss').click({ timeout: 5_000 }).catch(() => {});

    const chip = page.locator('.olv-rvc');
    await expect(chip).not.toHaveClass(/olv-hidden/, { timeout: 30_000 });

    // A real mouse hover — mouseenter/mouseleave, not a scripted class
    // toggle — over the chip's Apply button.
    await chip.locator('.olv-rvc-apply').hover();
    await page.waitForTimeout(9_500); // past the 9s auto-hide the chip would otherwise honour
    await expect(chip).not.toHaveClass(/olv-hidden/);

    // Moving the pointer off resumes the timer from a fresh 9s.
    await page.mouse.move(0, 0);
    await expect(chip).toHaveClass(/olv-hidden/, { timeout: 15_000 });
  });
});

test('the Inspect tool announces its Copy outcome through the shared live region', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(1500); // let the framing tween settle before picking
  await page.locator('.olv-tool', { hasText: 'Inspect' }).click();
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });

  const copyBtn = page.locator('.olv-inspect-copy');
  await expect(copyBtn).toBeVisible({ timeout: 10_000 });
  await expect(copyBtn).toHaveText('Copy');

  await copyBtn.click();

  // Whichever the clipboard permission model in this browser project
  // resolves to, the outcome — success or failure — reaches the shared
  // live region. A silent no-op (the pre-fix behaviour) matches neither.
  await expect(page.locator(LIVE_REGION)).toHaveText(/Point info copied|Copy failed/, {
    timeout: 5_000,
  });
  const announced = await liveRegionText(page);
  if (announced === 'Point info copied') {
    await expect(copyBtn).toHaveText('Copied');
  } else {
    await expect(copyBtn).toHaveText('Copy');
  }
});
