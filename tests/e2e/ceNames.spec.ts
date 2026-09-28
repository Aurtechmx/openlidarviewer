/**
 * ceNames.spec.ts: one name per action in the running app (CE-NAME-01) and
 * the dock agreeing with the rail about what is active (CE-NAME-03).
 *
 * The unit test `actionNames.test.ts` checks each builder; this checks what a
 * user sees once the shell has composed them: the dock, the palette rows and
 * the Tools launcher name an action the same way, and a dock tool that opens a
 * rail page reads pressed exactly while the rail shows it.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

test.use({ viewport: { width: 1440, height: 900 } });

async function openScan(page: Page, navigate = true): Promise<void> {
  if (navigate) await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock [data-action="tool.measure"]')).toBeEnabled({ timeout: 20_000 });
}

const dock = (page: Page, id: string) => page.locator(`.olv-dock [data-action="${id}"]`);

test('the dock, the palette and the launcher use the same names', async ({ page }) => {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-open-btn')).toHaveAccessibleName('Open scan');
  await openScan(page, false);
  const names: Record<string, string> = {
    'camera.frame-all': 'Frame all',
    'tool.snapshot': 'Save a snapshot',
    'tool.measure': 'Measure',
    'tool.inspect': 'Inspect',
    'tool.annotate': 'Annotate',
    'tool.share': 'Copy view link',
  };
  for (const [id, name] of Object.entries(names)) {
    await expect(dock(page, id)).toHaveAccessibleName(name);
  }
  await expect(page.locator('.olv-navbar .olv-mode-reset')).toHaveAccessibleName('Frame all');

  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette-row').first()).toBeVisible();
  const titles = await page.locator('.olv-palette-row .olv-palette-row-title').allTextContents();
  for (const name of Object.values(names)) expect(titles, name).toContain(name);
  await page.keyboard.press('Escape');

  await page.locator('.olv-ws-tab[data-mode="work"]').click();
  const rows = await page.locator('#olv-ws-mode-work .olv-tl-row .olv-tl-title').allTextContents();
  for (const id of ['tool.measure', 'tool.inspect', 'tool.annotate']) expect(rows, id).toContain(names[id]);
});

test('a dock tool reads pressed exactly while the rail shows its page', async ({ page }) => {
  await openScan(page);
  const title = page.locator('#olv-ws-mode-work .olv-ws-task-title');

  await dock(page, 'tool.measure').click();
  await expect(dock(page, 'tool.measure')).toHaveAttribute('aria-pressed', 'true');
  await expect(title).toHaveText('Measure');
  await expect(page.locator('.olv-ws-tab[data-mode="work"]')).toHaveAttribute('aria-selected', 'true');

  await dock(page, 'tool.annotate').click();
  await expect(dock(page, 'tool.annotate')).toHaveAttribute('aria-pressed', 'true');
  await expect(dock(page, 'tool.measure')).toHaveAttribute('aria-pressed', 'false');
  await expect(title).toHaveText('Annotate');

  await dock(page, 'tool.annotate').click();
  await expect(dock(page, 'tool.annotate')).toHaveAttribute('aria-pressed', 'false');
  await expect(title).not.toHaveText('Annotate');

  // Analyse: pressed while the rail shows Analyse, released on another mode.
  await dock(page, 'tool.analyse').click();
  await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toHaveAttribute('aria-selected', 'true');
  await expect(dock(page, 'tool.analyse')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.olv-ws-tab[data-mode="data"]').click();
  await expect(dock(page, 'tool.analyse')).toHaveAttribute('aria-pressed', 'false');
});
