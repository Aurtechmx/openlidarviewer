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

  test('stays visible past its auto-hide timer while genuinely hovered', async ({ page }) => {
    const fixture = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));
    // The test seam shortens the chip's 9 s auto-hide so the pause is checked
    // against a known, short timer. `data-autohide` on the chip reports the
    // timer state (running / paused / off) directly, so the test asserts that
    // the hover itself paused it rather than inferring it from elapsed time.
    // `page.clock` is not used: it raced a `Date.now()` read and stalled an
    // rAF-gated render in this Playwright's Chromium.
    const HIDE_MS = 1_500;
    // Hold the timer with keyboard focus the moment the chip appears. A
    // MutationObserver installed before the app boots sees `show()` drop
    // `olv-hidden` and focuses Apply in the same task (a microtask), so the
    // short timer can never lapse first. A page-side poll could not promise
    // that: under parallel load the main thread stalls for longer than
    // HIDE_MS, the chip shows and auto-hides between two polls, and the poll
    // then waits for a chip that never comes back. The focus is dropped
    // again below, once the hover has landed, so the hover alone is what
    // keeps the chip up.
    await page.addInitScript(() => {
      const w = window as unknown as { __rvcShown?: boolean };
      // Observe `document` itself: an init script can run before <html> exists.
      new MutationObserver(() => {
        const c = document.querySelector('.olv-rvc');
        if (w.__rvcShown || !c || c.classList.contains('olv-hidden')) return;
        c.querySelector<HTMLElement>('.olv-rvc-apply')?.focus();
        w.__rvcShown = true;
      }).observe(document, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    });
    await page.goto(`/?test=1&rvcHideMs=${HIDE_MS}`);
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(fixture);
    const card = page.locator('.olv-project-card');
    await expect(card).toHaveClass(/olv-visible/, { timeout: 60_000 });
    await page.locator('.olv-pc-dismiss').click({ timeout: 5_000 }).catch(() => {});

    await page.waitForFunction(() => (window as unknown as { __rvcShown?: boolean }).__rvcShown === true, undefined, {
      timeout: 30_000,
    });
    const chip = page.locator('.olv-rvc');
    await expect(chip).toHaveAttribute('data-autohide', 'paused');

    const apply = chip.locator('.olv-rvc-apply');
    // Entrance animation settled before hovering, so the pointer targets the
    // chip's resting position. The animation is finished outright rather
    // than waited on: under parallel load a starved main thread can hold its
    // 200 ms entrance at an early frame for longer than any wait budget, and
    // the chip's motion is not what this test checks.
    await apply.evaluate((el) => {
      for (const a of el.closest('.olv-rvc')!.getAnimations()) a.finish();
    });
    // Nothing else answers for the button's own point (stacking/paint guard).
    await expect
      .poll(
        () =>
          apply.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        { timeout: 20_000 },
      )
      .toBe(true);

    // A real mouse hover (mouseenter), then release the keyboard focus. The
    // pointer starts outside the chip: an earlier click can leave it resting
    // where the chip appears, and Firefox fires mouseenter only when the
    // pointer moves in, not when an element appears under a still pointer.
    await page.mouse.move(0, 0);
    await apply.hover();
    await apply.evaluate((el) => (el as HTMLElement).blur());
    await expect(chip).toHaveAttribute('data-autohide', 'paused');

    // Three full timer lengths later the hovered chip is still up. The pointer
    // is nudged within the button every 200 ms instead of left idle: Firefox
    // headful under Xvfb periodically resyncs to the real X cursor (parked at
    // the screen centre, outside the chip) and fires a window-level
    // mouseleave (relatedTarget null) that the chip rightly treats as the
    // pointer leaving. A nudge re-enters well inside one timer length, so the
    // chip can only still be up at the end if hovering keeps pausing it.
    // Each 200 ms tick nudges the pointer and reads the chip's state; the
    // poll settles once three timer lengths have passed with the chip paused
    // at every tick.
    const start = Date.now();
    let tick = 0;
    await expect
      .poll(
        async () => {
          // Re-read the box each tick so a nudge always lands on the button
          // where it is now, not where it was when the hold began.
          const box = (await apply.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2 + (tick++ % 2 ? 2 : -2), box.y + box.height / 2);
          const state = await chip.getAttribute('data-autohide');
          if (state !== 'paused') return `not paused: ${state}`;
          return Date.now() - start >= HIDE_MS * 3 ? 'held' : 'holding';
        },
        { intervals: [200], timeout: HIDE_MS * 3 + 10_000 },
      )
      .toBe('held');
    await expect(chip).not.toHaveClass(/olv-hidden/);
    await expect(chip).toHaveAttribute('data-autohide', 'paused');

    // Leaving restarts the timer, and the chip then hides on its own.
    await page.mouse.move(0, 0);
    await expect(chip).toHaveClass(/olv-hidden/, { timeout: 15_000 });
    await expect(chip).toHaveAttribute('data-autohide', 'off');
  });
});

test('the Inspect tool announces its Copy outcome through the shared live region', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.locator('.olv-tool', { hasText: 'Inspect' }).click();
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');

  const copyBtn = page.locator('.olv-inspect-copy');
  // Waits on the click actually landing rather than on the framing tween's
  // duration — early on the tween is still settling, so the first click at
  // dead centre can legitimately miss (same idiom as tilesetOpen.spec.ts).
  const offsets = [0.5, 0.46, 0.54, 0.42, 0.58];
  let attempt = 0;
  await expect
    .poll(async () => {
      const f = offsets[attempt++ % offsets.length];
      await canvas.click({ position: { x: box.width * f, y: box.height * f } });
      return copyBtn.isVisible();
    }, { timeout: 10_000 })
    .toBe(true);
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
