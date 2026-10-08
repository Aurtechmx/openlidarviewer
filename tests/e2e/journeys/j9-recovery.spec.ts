/**
 * J9 Mistakes and recovery: a corrupt file, a double-clicked Export, Escape in
 * each dialog, going offline after load, and a lost WebGL context. After each,
 * the scene must still work and nothing may stay busy.
 */
import { test, expect, type Page } from '@playwright/test';
import { buildSurveyLas14, dropBytes, openWith, startJourney } from './helpers/journey';
import { showWorkspaceMode, waitForCameraSettled } from '../helpers';

test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

async function exportPanel(page: Page) {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  return panel;
}

test('P1: a corrupt file is refused with an actionable message and a good file still opens', async ({ page }, info) => {
  const j = startJourney(page, info, 'j9', [
    { pattern: /not a valid|could not|failed to (read|parse|decode)|invalid LAS|unexpected end/i, reason: 'the corrupt-file step logs the decode failure it reports to the user' },
  ]);
  await j.step('drop a truncated LAS', async () => {
    await page.goto('/?test=1');
    const junk = new Uint8Array(400);
    junk.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF", then nothing that parses
    await dropBytes(page, junk, 'broken.las');
    const toast = page.locator('.olv-toast');
    await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
    const text = (await toast.innerText()).replace(/\s+/g, ' ');
    await info.attach('message.txt', { body: text, contentType: 'text/plain' });
    expect(text.length, 'the message says more than "error"').toBeGreaterThan(30);
    await expect(page.locator('.olv-empty')).toBeVisible();
    await expect(toast).not.toHaveClass(/is-busy/);
  });
  await j.step('a good file opens afterwards', async () => {
    const survey = await buildSurveyLas14();
    await dropBytes(page, survey.bytes, 'survey-14.las');
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  });
});

test('P1: double-clicking Export writes one file and the button comes back', async ({ page }, info) => {
  const j = startJourney(page, info, 'j9');
  const survey = await buildSurveyLas14();
  await j.step('open the scan', () => openWith(page, survey.bytes, 'survey-14.las'));
  await j.step('double-click Export on XYZ', async () => {
    const panel = await exportPanel(page);
    await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
    const names: string[] = [];
    page.on('download', (d) => names.push(d.suggestedFilename()));
    await panel.locator('.olv-bc-convert').dblclick();
    await expect.poll(() => names.length, { timeout: 15_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(2_000);
    expect(names, `downloads: ${names.join(', ')}`).toHaveLength(1);
    await expect(panel.locator('.olv-bc-convert')).toBeEnabled({ timeout: 10_000 });
  });
});

test('P1: Escape closes every dialog', async ({ page }, info) => {
  const j = startJourney(page, info, 'j9');
  const survey = await buildSurveyLas14();
  await j.step('open the scan', () => openWith(page, survey.bytes, 'survey-14.las'));
  const dialogs: Array<{ name: string; open: () => Promise<void>; sel: string }> = [
    { name: 'command palette', open: () => page.keyboard.press('ControlOrMeta+KeyK'), sel: '.olv-palette' },
    { name: 'shortcut sheet', open: async () => { await page.locator('.olv-canvas').focus(); await page.keyboard.press('Shift+Slash'); }, sel: '.olv-shortcuts' },
    { name: 'help overlay', open: () => page.getByRole('button', { name: /^Help$/ }).first().click(), sel: '.olv-help-backdrop' },
  ];
  for (const d of dialogs) {
    await j.step(`${d.name}: open, then Escape`, async () => {
      await d.open();
      await expect(page.locator(d.sel)).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      await expect(page.locator(d.sel)).toBeHidden({ timeout: 5_000 });
    });
  }
});

test('P1: after going offline the loaded scan still exports and the report lane still opens', async ({ page, context }, info) => {
  test.setTimeout(90_000);
  // J9-OFFLINE: once the network drops, a lazy chunk that fails to load is
  // not treated as a stale deploy. The page stays, the scan stays, and the
  // part that could not load says so and can be retried.
  const j = startJourney(page, info, 'j9', [
    { pattern: /ERR_INTERNET_DISCONNECTED|NetworkError|Load failed|Failed to fetch|Failed to load resource/i, reason: 'this test turns the network off on purpose; the request failures are expected, an uncaught error is not' },
  ]);
  const survey = await buildSurveyLas14();
  // The service worker is skipped under ?test=1 and under automation, so this
  // test opens the app as a user does (offlineReady.spec.ts does the same).
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
  });
  await j.step('open the scan with the service worker in control', async () => {
    await page.goto('/');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
    });
    await dropBytes(page, survey.bytes, 'survey-14.las');
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
    await exportPanel(page);
    await page.waitForLoadState('networkidle');
  });
  await j.step('go offline and export XYZ: it downloads, or says it is offline, and the scan stays', async () => {
    await context.setOffline(true);
    const panel = await exportPanel(page);
    await panel.locator('.olv-bc-pill', { hasText: 'XYZ' }).click();
    // The converter is a lazy chunk. Without "Make available offline" the
    // service worker holds only the chunks already fetched, so offline the
    // export either runs from cache or reports that it could not load.
    const dl = page.waitForEvent('download', { timeout: 20_000 }).then((d) => d.suggestedFilename(), () => null);
    await panel.locator('.olv-bc-convert').click();
    const offlineNote = panel.getByText('You are offline, this part could not load.', { exact: false });
    const name = await Promise.race([dl, offlineNote.first().waitFor({ timeout: 20_000 }).then(() => 'offline-note')]);
    expect(name === 'offline-note' || /\.xyz$/.test(String(name)), `export outcome: ${name}`).toBe(true);
    await expect(page.locator('.olv-empty')).toBeHidden();
  });
  await j.step('open the Products lane offline: it loads or says it cannot, without an uncaught error', async () => {
    const panel = page.locator('.olv-export-panel');
    const head = panel.locator('.olv-export-products-head');
    if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
    await page.waitForTimeout(3_000);
    // Still on the same page: a reload attempt offline would leave the app.
    await expect(page.locator('.olv-export-panel')).toBeVisible();
  });
  await context.setOffline(false);
});

test('P1: a lost WebGL context is restored with the measurement intact', async ({ page }, info) => {
  const j = startJourney(page, info, 'j9', [
    { pattern: /CONTEXT_LOST_WEBGL|context lost|WebGL context|WebGL Device Lost/i, reason: 'this step loses the WebGL context on purpose; three.js logs the loss as an error' },
  ]);
  const survey = await buildSurveyLas14();
  await j.step('open the scan and measure', async () => {
    await openWith(page, survey.bytes, 'survey-14.las');
    await waitForCameraSettled(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__: { setMeasureKind: (k: string) => void; placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void } }).__OLV_TEST_API__;
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 3, y: 4, z: 0 });
    });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  });
  const canvas = page.locator('.olv-canvas');
  const hasExt = await canvas.evaluate((c) => !!(c as HTMLCanvasElement).getContext('webgl2')?.getExtension('WEBGL_lose_context'));
  test.skip(!hasExt, 'the viewer is not on WebGL 2 with WEBGL_lose_context here (WebGPU loss cannot be forced)');
  await j.step('lose and restore the context', async () => {
    await canvas.evaluate((c) => {
      const ext = (c as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
      (window as unknown as { __jLose: WEBGL_lose_context }).__jLose = ext;
      ext.loseContext();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as unknown as { __jLose: WEBGL_lose_context }).__jLose.restoreContext());
    await expect(page.locator('.olv-toast-text')).toHaveText('Graphics context restored; the view has been redrawn.', { timeout: 10_000 });
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
  });
});
