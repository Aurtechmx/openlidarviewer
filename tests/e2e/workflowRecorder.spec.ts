import { test, expect, type Page } from '@playwright/test';

/**
 * v0.3.9 workflow recorder — Cmd-Shift-R / Ctrl-Shift-R.
 *
 * The pure data layer (event schema, file format, scheduler) is
 * covered by workflowRecorder.test.ts (25 unit tests). This spec
 * exercises the DOM wiring: Cmd-Shift-R toggles a visible recording
 * badge; the badge carries a Stop button; firing an action while
 * recording captures into the live session; stopping triggers a
 * file download via a programmatic <a download> click.
 */

async function pressRecordToggle(page: Page): Promise<void> {
  // Playwright's `ControlOrMeta` maps to Cmd on macOS, Ctrl elsewhere.
  await page.keyboard.press('ControlOrMeta+Shift+KeyR');
}

test.describe('workflow recorder — recording lifecycle', () => {
  test('Cmd-Shift-R shows the recording badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-workflow-badge')).toBeHidden();
    await pressRecordToggle(page);
    const badge = page.locator('.olv-workflow-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/olv-workflow-badge-recording/);
    await expect(badge.locator('.olv-workflow-badge-label')).toContainText(
      'Recording',
    );
  });

  test('the badge exposes a Stop button while recording', async ({ page }) => {
    await page.goto('/');
    await pressRecordToggle(page);
    const stopBtn = page
      .locator('.olv-workflow-badge')
      .locator('.olv-workflow-badge-stop');
    await expect(stopBtn).toBeVisible();
    await expect(stopBtn).toHaveText('Stop');
  });

  test('clicking Stop hides the badge when nothing was recorded', async ({
    page,
  }) => {
    await page.goto('/');
    await pressRecordToggle(page);
    await page
      .locator('.olv-workflow-badge')
      .locator('.olv-workflow-badge-stop')
      .click();
    await expect(page.locator('.olv-workflow-badge')).toBeHidden();
  });

  test('Cmd-Shift-R twice toggles the badge off', async ({ page }) => {
    await page.goto('/');
    await pressRecordToggle(page);
    await expect(page.locator('.olv-workflow-badge')).toBeVisible();
    await pressRecordToggle(page);
    await expect(page.locator('.olv-workflow-badge')).toBeHidden();
  });
});

test.describe('workflow recorder — command palette integration', () => {
  test('the palette surfaces three workflow actions', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('workflow');
    const rows = page.locator('.olv-palette-row');
    expect(await rows.count()).toBeGreaterThanOrEqual(3);
    await expect(
      page.locator('.olv-palette-row', { hasText: 'Start recording workflow' }),
    ).toBeVisible();
    await expect(
      page.locator('.olv-palette-row', { hasText: 'Stop and save workflow' }),
    ).toBeVisible();
    await expect(
      page.locator('.olv-palette-row', { hasText: 'Replay a workflow file' }),
    ).toBeVisible();
  });

  test('Start recording from the palette shows the badge', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.locator('.olv-palette-input').fill('Start recording');
    await page.locator('.olv-palette-input').press('Enter');
    await expect(page.locator('.olv-palette')).toBeHidden();
    await expect(page.locator('.olv-workflow-badge')).toBeVisible();
  });
});

test.describe('workflow recorder — capture into a live session', () => {
  test('firing an action while recording does not throw', async ({ page }) => {
    // We can't easily assert the in-memory session contents from
    // Playwright, but we CAN confirm no console error fires when an
    // action captures while recording is active. If the discriminated
    // union narrows incorrectly the capture call would throw at
    // runtime; this spec is the smoke test for that path.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await pressRecordToggle(page);
    // Fire a few actions via the command palette so capture()
    // exercises each event type variant.
    for (const query of ['Top view', 'Dark theme', 'Frame all']) {
      await page.keyboard.press('ControlOrMeta+KeyK');
      await page.locator('.olv-palette-input').fill(query);
      await page.locator('.olv-palette-input').press('Enter');
      await page.waitForTimeout(150);
    }
    // Stop the recording. The download is intercepted by Playwright;
    // we just confirm the page didn't throw at any point.
    page.on('download', async (d) => {
      // Acknowledge the download so the browser doesn't hang on it.
      await d.cancel();
    });
    await pressRecordToggle(page);
    expect(errors).toEqual([]);
  });
});
