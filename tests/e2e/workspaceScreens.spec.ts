/**
 * Review screenshots of the workspace at six viewports: Data home, Tools home,
 * Measure, Analyse home, Terrain, Contours, Export home, the Inspector and the
 * Results list. Opt-in: runs only when OLV_UX_SHOTS names an output folder, so
 * CI never writes images. Each stop also records the rail or sheet layout
 * facts a reviewer checks by eye (clipped titles, a hidden Back, a second
 * scrollbar) into `<folder>/layout.json`.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dropDenseGridPly, placeTestDistance } from './helpers';

const OUT = process.env.OLV_UX_SHOTS;

const VIEWPORTS = [
  { name: '1366x768', width: 1366, height: 768, touch: false },
  { name: '1440x900', width: 1440, height: 900, touch: false },
  { name: '1920x1080', width: 1920, height: 1080, touch: false },
  { name: 'touch-1366x1024', width: 1366, height: 1024, touch: true },
  { name: '390x844', width: 390, height: 844, touch: true },
  { name: '844x390', width: 844, height: 390, touch: true },
] as const;

type Mode = 'data' | 'work' | 'analyse' | 'output' | 'view';

async function mode(page: Page, m: Mode): Promise<void> {
  const sheetTab = page.locator(`.olv-mobile-sheet .olv-msheet-tab[data-tab="${m}"]`);
  if (await sheetTab.isVisible()) {
    await sheetTab.click();
    // A tab tap from peek opens the sheet; give it the half detent at least.
    return;
  }
  if (m !== 'view') await page.locator(`.olv-ws-tab[data-mode="${m}"]`).click();
}

async function home(page: Page, m: Mode): Promise<void> {
  await mode(page, m);
  const back = page.locator(`#olv-ws-mode-${m} .olv-ws-back`);
  while (await back.isVisible()) await back.click();
}

async function layoutFacts(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const host = Array.from(document.querySelectorAll<HTMLElement>('.olv-ws-mode.is-active')).find((m) => m.getBoundingClientRect().height > 0);
    const title = host?.querySelector<HTMLElement>('.olv-ws-task-title');
    const back = host?.querySelector<HTMLElement>('.olv-ws-back');
    const inView = (el: HTMLElement | null | undefined): boolean => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
    };
    const scrollers = Array.from(document.querySelectorAll<HTMLElement>('#olv-left-panels *, .olv-mobile-sheet *')).filter((el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return r.height > 0 && /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    });
    const nested = scrollers.filter((s) => scrollers.some((o) => o !== s && o.contains(s))).map((s) => s.className);
    const small = Array.from((host ?? document.body).querySelectorAll<HTMLElement>('button, [role="button"], a, input'))
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 24; })
      .map((b) => (b.textContent ?? b.getAttribute('aria-label') ?? '').trim().slice(0, 30));
    return {
      page: title && !title.closest('[hidden]') ? title.textContent : 'home',
      titleClipped: title ? title.scrollWidth > title.clientWidth + 1 : false,
      backInView: back && !back.closest('[hidden]') ? inView(back) : null,
      nestedScrollers: nested,
      controlsUnder24px: small,
      pageScrollX: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

test.describe('workspace review screenshots', () => {
  test.skip(!OUT, 'set OLV_UX_SHOTS to a folder to write the review screenshots');
  test.slow();

  for (const vp of VIEWPORTS) {
    test(`screens at ${vp.name}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const dir = `${OUT}/${vp.name}`;
      mkdirSync(dir, { recursive: true });
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch });
      await context.addInitScript(() => { try { localStorage.setItem('olv:tour:v1:completed', '1'); } catch { /* none */ } });
      const page = await context.newPage();
      await page.goto('/?test=1');
      await dropDenseGridPly(page);
      await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      const facts: Record<string, unknown> = {};
      const shot = async (name: string): Promise<void> => {
        await page.waitForTimeout(350);
        facts[name] = await layoutFacts(page);
        await page.screenshot({ path: `${dir}/${name}.png` });
      };

      await home(page, 'data');
      await shot('data-home');
      await home(page, 'work');
      await shot('tools-home');
      await page.locator('.olv-tool-launcher .olv-tl-row', { hasText: 'Measure' }).first().click();
      await placeTestDistance(page);
      await mode(page, 'work');
      await shot('measure');
      await home(page, 'analyse');
      await shot('analyse-home');
      await page.locator('.olv-ah-row[data-analysis="terrain"] .olv-ah-open').click();
      await page.locator('.olv-analyse-run').click();
      await expect(page.locator('.olv-fit-verdict-text')).toBeVisible({ timeout: 60_000 });
      await shot('terrain');
      await page.locator('.olv-at-link', { hasText: 'Contours' }).click();
      await shot('contours');
      await home(page, 'output');
      await shot('export-home');
      await mode(page, 'view');
      await shot('inspector');
      await home(page, 'data');
      const toggle = page.locator('.olv-results-toggle').filter({ visible: true }).first();
      if ((await toggle.count()) && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await shot('results-expanded');
      writeFileSync(`${dir}/layout.json`, JSON.stringify(facts, null, 2));
      await context.close();
    });
  }
});
