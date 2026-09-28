/**
 * ceA11y.spec.ts: an automated accessibility audit of the main surfaces
 * (COMMUNITY_SPEC.md CE-ASK-04).
 *
 * axe-core (through @axe-core/playwright, a development-only dependency) runs
 * against six surfaces at desktop size and at 390x844: the empty state, a
 * loaded scan, the Analyse home, the Measure page, the Observatory lab and
 * the command palette. A serious or critical violation fails the run unless
 * it is listed in KNOWN below with the rule id and the surface, so a new
 * violation cannot hide behind an old one and a fixed one shows up as an
 * unused entry.
 *
 * The audit uses the WCAG 2.0, 2.1 and 2.2 A and AA rule tags. It is a floor,
 * not a conformance claim: automated rules find a subset of problems.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { dropTinyPtx, placeTestDistance, showWorkspaceMode, openToolPage, firePaletteAction } from './helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

type Surface = 'empty' | 'scan' | 'analyse' | 'measure' | 'lab' | 'palette';

/**
 * Serious or critical violations present when this audit was added, by
 * surface and rule id, each with the reason it is not fixed here. An entry
 * that no longer fires fails the run, so the list only shrinks.
 */
const KNOWN: ReadonlyArray<{ viewport: 'desktop' | 'phone'; surface: Surface; rule: string; why: string }> = [];

const VIEWPORTS = [
  { name: 'desktop', size: { width: 1440, height: 900 }, touch: false },
  { name: 'phone', size: { width: 390, height: 844 }, touch: true },
] as const;

async function openScan(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await dropTinyPtx(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-dock [data-action="tool.measure"]')).toBeEnabled({ timeout: 20_000 });
}

async function reach(page: Page, surface: Surface, phone: boolean): Promise<void> {
  if (surface === 'empty') {
    await page.goto('/?test=1');
    await expect(page.locator('.olv-open-btn')).toBeVisible();
    return;
  }
  await openScan(page);
  if (surface === 'analyse') {
    if (phone) await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="analyse"]').click();
    else await showWorkspaceMode(page, 'analyse');
    await expect(page.locator('.olv-ah-row[data-analysis="terrain"]')).toBeVisible();
  } else if (surface === 'measure') {
    if (phone) {
      await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
      await page.locator('.olv-msheet-slot[data-tab="work"] .olv-tl-row', { hasText: 'Measure' }).click();
      await placeTestDistance(page);
      await page.locator('.olv-mobile-sheet .olv-msheet-tab[data-tab="work"]').click();
    } else {
      await openToolPage(page, 'Measure');
      await placeTestDistance(page);
    }
    await expect(page.locator('.olv-measure-panel')).toBeVisible();
  } else if (surface === 'lab') {
    await firePaletteAction(page, 'Observatory', 'Observatory (observation evidence)');
    await expect(page.locator('.olv-analyse-page[data-page="observatory"] .olv-observatory-section-title').first()).toBeVisible({ timeout: 20_000 });
  } else if (surface === 'palette') {
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible();
  }
}

const SURFACES: readonly Surface[] = ['empty', 'scan', 'analyse', 'measure', 'lab', 'palette'];

for (const vp of VIEWPORTS) {
  test.describe(`accessibility audit, ${vp.name}`, () => {
    test.use({ viewport: vp.size, hasTouch: vp.touch, isMobile: vp.touch });

    for (const surface of SURFACES) {
      test(`${surface}: no unlisted serious or critical violation`, async ({ page }) => {
        test.slow();
        await reach(page, surface, vp.touch);
        // Axe samples colours as drawn; let open transitions settle first.
        await page.evaluate(() => Promise.all(document.getAnimations()
          .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
          .map((a) => a.finished.catch(() => undefined))));
        const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const severe = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        const known = KNOWN.filter((k) => k.surface === surface && k.viewport === vp.name);
        const unlisted = severe
          .filter((v) => !known.some((k) => k.rule === v.id))
          .map((v) => `${v.id} (${v.impact}): ${v.help} at ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
        expect(unlisted, 'serious or critical violations not in KNOWN').toEqual([]);
        const stale = known.filter((k) => !severe.some((v) => v.id === k.rule)).map((k) => k.rule);
        expect(stale, 'KNOWN entries that no longer fire here; remove them').toEqual([]);
      });
    }
  });
}
