import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * tests/e2e/railSingleScroller.spec.ts
 *
 * One vertical scroller per surface. On desktop the left rail scrolls only in
 * the active mode body (`.olv-ws-body`), with the tab strip fixed above it; on
 * a phone each sheet slot scrolls only in `.olv-msheet-body`. Nested bounded
 * scroll boxes (the rail column itself, the profile station table, the phone
 * annotation band) trap the wheel and the finger in a box inside a box.
 *
 * The check: inside the surface, no element other than the designated
 * scroller has a computed `overflow-y` of auto/scroll while its content
 * actually overflows it. The panel content is made tall on purpose (a profile
 * with its station table open) so an inner scroller would really scroll.
 */

const MODES = ['data', 'work', 'analyse', 'output'] as const;
const SLOTS = ['View', 'Analyse', 'Layers'] as const;

interface ScrollAudit {
  /** Elements with overflow-y auto/scroll, designated scroller included. */
  candidates: string[];
  /** Candidates other than the designated scroller whose content overflows. */
  offenders: string[];
}

async function audit(page: Page, roots: string[], designated: string): Promise<ScrollAudit> {
  return page.evaluate(
    ({ roots, designated }) => {
      const label = (e: Element): string =>
        `${e.tagName.toLowerCase()}.${Array.from(e.classList).join('.')}`;
      const seen = new Set<Element>();
      const candidates: string[] = [];
      const offenders: string[] = [];
      for (const sel of roots) {
        for (const root of Array.from(document.querySelectorAll(sel))) {
          for (const e of [root, ...Array.from(root.querySelectorAll('*'))]) {
            if (seen.has(e)) continue;
            seen.add(e);
            const h = e as HTMLElement;
            if (h.getClientRects().length === 0) continue;
            const oy = getComputedStyle(h).overflowY;
            if (oy !== 'auto' && oy !== 'scroll') continue;
            candidates.push(label(h));
            if (h.matches(designated)) continue;
            if (h.scrollHeight > h.clientHeight + 1) offenders.push(label(h));
          }
        }
      }
      return { candidates, offenders };
    },
    { roots, designated },
  );
}

async function placeProfile(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: {
        setMeasureKind: (k: string) => void;
        placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
        finishMeasurement?: () => void;
      };
    }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted');
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y: 0, z: 0 });
    api.finishMeasurement?.();
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

async function load(page: Page): Promise<void> {
  await suppressOnboardingTour(page);
  // Open the station table on first render so its rows are in the layout.
  await page.addInitScript(() => {
    try { localStorage.setItem('olv:measure:profile:stationsOpen:v1', '1'); } catch { /* none */ }
  });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

test.describe('desktop rail at 1366x768', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('each workspace mode scrolls only in its mode body', async ({ page }) => {
    test.slow();
    await load(page);
    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    await placeProfile(page);

    for (const mode of MODES) {
      await showWorkspaceMode(page, mode);
      await page.waitForTimeout(200);
      const r = await audit(page, ['.olv-left-panels'], '.olv-ws-body');
      console.log(`[scrollers] desktop ${mode}: ${r.candidates.length} (${r.candidates.join(', ')})`);
      expect.soft(r.offenders, `${mode}: nested scrollers`).toEqual([]);
    }
  });
});

test.describe('phone sheet at 390x844', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('each sheet slot scrolls only in the sheet body', async ({ page }) => {
    test.slow();
    await load(page);
    // A measurement puts the Measurements panel (and its open station table)
    // into the Analyse slot, the tallest content a slot carries.
    // The open sheet covers the dock, so Measure is armed by its M shortcut.
    await page.keyboard.press('m');
    await placeProfile(page);
    for (const slot of SLOTS) {
      await page.locator('.olv-msheet-tab', { hasText: slot }).click();
      await page.waitForTimeout(300);
      const r = await audit(page, ['.olv-mobile-sheet', '.olv-left-panels'], '.olv-msheet-body');
      console.log(`[scrollers] phone ${slot}: ${r.candidates.length} (${r.candidates.join(', ')})`);
      expect.soft(r.offenders, `${slot}: nested scrollers`).toEqual([]);
    }
  });
});
