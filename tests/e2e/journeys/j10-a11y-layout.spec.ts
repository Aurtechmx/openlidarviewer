/**
 * J10 Accessibility and layout: axe on the main surfaces, keyboard focus that
 * is visible, touch targets of at least 44 px on a phone, no horizontal
 * overflow at phone width or at 200% zoom, and legends that do not rely on
 * colour alone.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { buildSurveyLas14, fixtureBytes, openWith, startJourney } from './helpers/journey';
import { openClassesPage, showWorkspaceMode } from '../helpers';

const TAGS = ['wcag2a', 'wcag2aa'];

async function seriousViolations(page: Page, include?: string): Promise<string[]> {
  let b = new AxeBuilder({ page }).withTags(TAGS);
  if (include) b = b.include(include);
  const r = await b.analyze();
  return r.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe('J10 desktop', () => {
  test.skip(() => test.info().project.use.hasTouch === true, 'desktop journey');

  test('P2: axe finds no serious violations on the empty state, the scene, Export and Measure', async ({ page }, info) => {
    test.setTimeout(120_000);
    const j = startJourney(page, info, 'j10');
    await j.step('empty state', async () => {
      await page.goto('/?test=1');
      await expect(page.locator('.olv-empty')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
    const survey = await buildSurveyLas14();
    await j.step('loaded scene', async () => {
      await openWith(page, survey.bytes, 'survey-14.las');
      expect(await seriousViolations(page)).toEqual([]);
    });
    await j.step('Export panel', async () => {
      await showWorkspaceMode(page, 'output');
      await expect(page.locator('.olv-export-panel')).toBeVisible({ timeout: 20_000 });
      expect(await seriousViolations(page, '.olv-export-panel')).toEqual([]);
    });
    await j.step('Measure', async () => {
      await page.locator('.olv-tool', { hasText: 'Measure' }).click();
      await expect(page.locator('.olv-measure-bar')).toBeVisible();
      expect(await seriousViolations(page, '.olv-measure-bar')).toEqual([]);
    });
  });

  test('P2: keyboard only, every focus stop is visible and the palette keeps focus inside', async ({ page, browserName }, info) => {
    // WebKit's default keyboard mode leaves plain buttons out of the native Tab
    // order, so a native Tab walk is not a user path there (dialogFocus.spec.ts
    // skips the same walk for the same reason).
    test.skip(browserName === 'webkit', 'WebKit omits buttons from native Tab order by default');
    const j = startJourney(page, info, 'j10');
    const survey = await buildSurveyLas14();
    await j.step('open the scan', () => openWith(page, survey.bytes, 'survey-14.las'));
    await j.step('Tab through the first 25 stops', async () => {
      await page.locator('body').click({ position: { x: 1, y: 1 } }).catch(() => undefined);
      const invisible: string[] = [];
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const r = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const box = el.getBoundingClientRect();
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
          return { label: `${el.tagName.toLowerCase()}.${el.className}`.slice(0, 80) + ` "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`, ring: !!ring, onScreen: box.width > 0 && box.height > 0 };
        });
        if (r && (!r.ring || !r.onScreen)) invisible.push(`${r.label} ring=${r.ring} onScreen=${r.onScreen}`);
      }
      await info.attach('focus-stops.txt', { body: invisible.join('\n') || 'all visible', contentType: 'text/plain' });
      expect(invisible, 'focus stops with no visible indicator').toEqual([]);
    });
    await j.step('the palette traps Tab and closes on Escape', async () => {
      await page.keyboard.press('ControlOrMeta+KeyK');
      const palette = page.locator('.olv-palette');
      await expect(palette).toBeVisible();
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        expect(await palette.evaluate((p) => p.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
    });
  });

  test('P1: at 200% zoom nothing overflows sideways and the class legend has text labels', async ({ page }, info) => {
    // 200% browser zoom on a 1440 x 900 window lays out as 720 x 450 CSS px.
    await page.setViewportSize({ width: 720, height: 450 });
    const j = startJourney(page, info, 'j10');
    await j.step('open the classified scan', () => openWith(page, fixtureBytes('terrain-access-utm.las'), 'terrain-access-utm.las'));
    await j.step('no horizontal overflow', async () => {
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
    await j.step('every class legend row has a text label', async () => {
      await openClassesPage(page);
      const rows = page.locator('.olv-class-panel .olv-cl-row');
      await expect(rows.first()).toBeVisible({ timeout: 10_000 });
      const unlabeled = await rows.evaluateAll((els) => els.filter((e) => ((e as HTMLElement).innerText ?? '').trim().length === 0).length);
      expect(unlabeled).toBe(0);
    });
  });
});

test.describe('J10 touch (P3)', () => {
  test.skip(() => test.info().project.use.hasTouch !== true, 'touch journey runs on webkit-mobile');

  test('P3: on a phone nothing overflows and every visible control is at least 44 px', async ({ page }, info) => {
    // FINDING J10-TARGETS: on iPhone 15 (WebKit) the theme toggle (28 px),
    // performance button (30 px), state-strip items (24 px tall), colour
    // legend close (20 px), More tools (40 px wide) and the toast action
    // (31 px tall) are under 44 px. Recorded as an expected failure.
    test.fail();
    const j = startJourney(page, info, 'j10');
    await j.step('open the LAZ', () => openWith(page, fixtureBytes('multichunk.laz'), 'multichunk.laz'));
    await j.step('no horizontal overflow at phone width', async () => {
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    });
    await j.step('touch targets', async () => {
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"], a[href], input, select, [role="tab"]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
          if (r.width < 44 || r.height < 44) out.push(`${Math.round(r.width)}x${Math.round(r.height)} ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`);
        }
        return out;
      });
      await info.attach('small-targets.txt', { body: small.join('\n') || 'none', contentType: 'text/plain' });
      expect(small, 'visible controls smaller than 44 x 44 px').toEqual([]);
    });
  });
});
