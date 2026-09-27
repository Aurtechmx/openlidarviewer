/**
 * The desktop left rail is one surface. With a scan loaded, every visible
 * element in the rail sits on an opaque background before the canvas, in each
 * mode, with the Results shelf open, in the light and dark themes. The shelf is
 * one block at the foot of the rail: toggle first, list below it, inside the
 * rail box, never over the task panel. Also covers what the rail and the dock
 * say after a terrain run: the readiness header, the Terrain page once
 * contours exist, the dock's Analyse button, and the single Frame control.
 * Deterministic project, synthetic dense-grid PLY.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly, openAnalysePage, showWorkspaceMode } from './helpers';

type Box = { x: number; y: number; width: number; height: number };

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
] as const;
const MODES = ['data', 'work', 'analyse', 'output'] as const;

const shelf = (page: Page) => page.locator('#olv-left-panels .olv-results-shelf');

function inside(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function loadAndRun(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('olv-theme', t);
    } catch {
      /* storage blocked: the default theme is dark */
    }
  }, theme);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await openAnalysePage(page, 'terrain');
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 30_000 });
  await expect(shelf(page).locator('.olv-results-toggle')).toHaveText(/Results · [2-9]/, { timeout: 20_000 });
}

async function openShelf(page: Page): Promise<void> {
  const toggle = shelf(page).locator('.olv-results-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.waitForTimeout(450); // the rail's entrance animation
}

/** Visible rail elements whose first opaque ancestor background is outside the rail. */
async function bareOverCanvas(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rail = document.getElementById('olv-left-panels');
    if (!rail) return ['no rail'];
    const opaque = (e: Element): boolean => {
      const c = getComputedStyle(e).backgroundColor;
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return (parts.length < 4 ? 1 : parts[3]) >= 0.99;
    };
    const bad: string[] = [];
    for (const e of Array.from(rail.querySelectorAll('*'))) {
      const h = e as HTMLElement;
      const r = h.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(h);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      let n: Element | null = h;
      let ok = false;
      while (n) {
        if (opaque(n)) { ok = true; break; }
        if (n === rail) break;
        n = n.parentElement;
      }
      if (!ok) bad.push(`${h.tagName.toLowerCase()}.${Array.from(h.classList).join('.')}`);
    }
    return bad;
  });
}

for (const size of SIZES) {
  test.describe(`left rail surface at ${size.width}x${size.height}`, () => {
    test.slow();
    test.use({ viewport: size });

    for (const theme of ['dark', 'light'] as const) {
      test(`${theme}: every rail element sits on an opaque surface in each mode, shelf open`, async ({ page }) => {
        await loadAndRun(page, theme);
        for (const mode of MODES) {
          await showWorkspaceMode(page, mode);
          await openShelf(page);
          expect(await bareOverCanvas(page), `mode ${mode}`).toEqual([]);
        }
      });
    }

    test('the shelf list sits inside the rail and clear of the task panel', async ({ page }) => {
      await loadAndRun(page, 'dark');
      const check = async (label: string): Promise<void> => {
        await openShelf(page);
        const rail = (await page.locator('#olv-left-panels').boundingBox())!;
        const task = (await page.locator('#olv-left-panels .olv-ws-body').boundingBox())!;
        const toggle = (await shelf(page).locator('.olv-results-toggle').boundingBox())!;
        const list = (await shelf(page).locator('.olv-results-panel').boundingBox())!;
        expect(inside(list, rail), `${label}: list inside rail`).toBe(true);
        expect(inside(toggle, rail), `${label}: toggle inside rail`).toBe(true);
        expect(intersects(list, task), `${label}: list clear of task panel`).toBe(false);
        expect(toggle.y, `${label}: toggle first, list below`).toBeLessThan(list.y);
      };
      await showWorkspaceMode(page, 'data');
      await check('data home');
      await openAnalysePage(page, 'terrain');
      await check('analyse terrain');
      await showWorkspaceMode(page, 'output');
      await check('export');
    });
  });
}

test.describe('what the rail and the dock say after a terrain run', () => {
  test.slow();
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('readiness header is calm and specific, amber for a limit', async ({ page }) => {
    await loadAndRun(page, 'dark');
    await showWorkspaceMode(page, 'output');
    const verdict = page.locator('.olv-export-panel .olv-health-verdict');
    await expect(verdict).toHaveText(/^\S*\s*Review before hand-off · \d+ items?$/);
    await expect(page.locator('.olv-export-panel .olv-health')).not.toContainText('Export with caution');
    await expect(page.locator('.olv-export-panel .olv-health')).not.toContainText(/streamed/i);
    const [color, warn] = await verdict.evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--warn)';
      el.append(probe);
      const w = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(el).color, w];
    });
    expect(color).toBe(warn);
    await expect(page.locator('.olv-export-panel .olv-health-blockers li.is-wrong')).toHaveCount(0);
    // A greyed format says why in words.
    await expect(page.locator('#olv-export-laz-note')).toContainText('LAZ is not available yet');
  });

  test('once contours exist the Terrain page links to them and says its verdict once', async ({ page }) => {
    await loadAndRun(page, 'dark');
    await openAnalysePage(page, 'terrain');
    const link = page.locator('#olv-ws-mode-analyse .olv-at-link');
    await expect(link).toHaveAttribute('data-made', 'true', { timeout: 20_000 });
    await expect(link.locator('.olv-ah-name')).toHaveText('Contours');
    await expect(link).not.toContainText('Create contours');
    const fit = (await page.locator('.olv-fit-verdict-text').textContent()) ?? '';
    const header = page.locator('#olv-ws-mode-analyse .olv-analyse-page[data-page="terrain"] .olv-at-reason');
    expect((await header.textContent()) ?? '').not.toBe(fit);
    await link.click();
    await expect(page.locator('#olv-ws-mode-analyse .olv-ws-task-title')).toHaveText('Contours');
  });

  test('the dock Analyse button follows the mode shown', async ({ page }) => {
    await loadAndRun(page, 'dark');
    const analyse = page.locator('.olv-tool-analyse');
    await openAnalysePage(page, 'terrain');
    await showWorkspaceMode(page, 'data');
    await expect(analyse).toHaveAttribute('aria-pressed', 'false');
    await expect(analyse).not.toHaveClass(/olv-tool-active/);
    // Pressing it from another mode opens Analyse rather than hiding a panel no one sees.
    await analyse.click();
    await expect(page.locator('.olv-ws-tab[data-mode="analyse"]')).toHaveAttribute('aria-selected', 'true');
    await expect(analyse).toHaveAttribute('aria-pressed', 'true');
  });

  test('the navigation cluster has one Frame control, clear of the Orbit pad', async ({ page }) => {
    await loadAndRun(page, 'dark');
    await expect(page.locator('.olv-mode-reset')).toHaveCount(1);
    const reset = (await page.locator('.olv-mode-reset').boundingBox())!;
    const orbit = (await page.locator('.olv-mode-orbit').boundingBox())!;
    expect(intersects(reset, orbit)).toBe(false);
  });
});
