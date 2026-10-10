/**
 * J11 Tablet touch targets: on a touch tablet (coarse pointer, no hover) every
 * visible interactive control in the dock, rails, panel headers, results shelf,
 * inspector, Data tab and the dialogs the spec opens is at least 44 x 44 CSS px.
 * Runs in the `journeys-tablet` project at 820 x 1180, 1180 x 820 and
 * 1024 x 1366. Exempt: an inline text link inside running text, a checkbox or
 * radio measured by its label, and a control whose 44 x 44 box around its centre
 * is entirely its own hit area (padding or a pseudo-element).
 */
import { test, expect, type Page } from '@playwright/test';
import { buildSurveyLas14, dropBytes, fixtureBytes, openWith, startJourney } from './helpers/journey';
import { LARGE_TOUCH_LAYOUT_QUERY } from '../../../src/platform/runtimeFormFactor';
import { openClassesPage, showWorkspaceMode } from '../helpers';

const MIN = 44;
const VIEWPORTS = [
  { name: 'portrait 820x1180', width: 820, height: 1180 },
  { name: 'landscape 1180x820', width: 1180, height: 820 },
  { name: 'large portrait 1024x1366', width: 1024, height: 1366 },
] as const;

interface Small { selector: string; label: string; size: string; where: string }

/** Visible controls under 44 px in the current page state. */
async function undersized(page: Page): Promise<Small[]> {
  return page.evaluate((min) => {
    const WHERE: Array<[string, string]> = [
      ['.olv-dock', 'dock'], ['.olv-rail-tab, .olv-right-rail-tab', 'rail tab'],
      ['.olv-results-actions, .olv-results-list, .olv-results-group, .olv-results-focus', 'results shelf'],
      ['#olv-ws-mode-data', 'Data tab'], ['.olv-right-rail', 'inspector'],
      ['.olv-left-panels', 'left rail'], ['.olv-navbar', 'navigation card'],
      ['.olv-viewcube', 'view cube'], ['.olv-state-strip', 'state strip'],
      ['.olv-modal, .olv-help-overlay, .olv-palette-card, .olv-shortcuts-card', 'dialog'],
    ];
    const where = (e: Element): string => WHERE.find(([s]) => e.closest(s))?.[1] ?? 'page';
    const describe = (e: Element): string => {
      const cls = [...e.classList].slice(0, 3).map((c) => `.${c}`).join('');
      return `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${cls}`;
    };
    const out: Small[] = [];
    const sel = 'button, [role="button"], [role="tab"], a[href], input, select, summary, [tabindex]:not([tabindex="-1"])';
    for (const e of document.querySelectorAll<HTMLElement>(sel)) {
      if (e.getAttribute('tabindex') !== null && Number(e.getAttribute('tabindex')) < 0) continue;
      if (e instanceof HTMLInputElement && (e.type === 'hidden' || e.type === 'file')) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue;
      if (e.closest('[hidden], [inert], [aria-hidden="true"], .olv-hidden')) continue;
      let box = e.getBoundingClientRect();
      // A checkbox or radio is pressed through its label.
      if (e instanceof HTMLInputElement && (e.type === 'checkbox' || e.type === 'radio')) {
        const lab = e.closest('label') ?? e.labels?.[0];
        if (lab) box = lab.getBoundingClientRect();
      }
      if (box.width === 0 || box.height === 0) continue;
      if (box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) continue;
      // Skip anything scrolled out of its own scroll container.
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      let clipped = false;
      for (let a = e.parentElement; a && !clipped; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const r = a.getBoundingClientRect();
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) clipped = true;
      }
      if (clipped) continue;
      if (box.width >= min - 0.5 && box.height >= min - 0.5) continue;
      // Inline link in running text.
      if (e instanceof HTMLAnchorElement && cs.display === 'inline' && (e.parentElement?.textContent ?? '').trim().length > (e.textContent ?? '').trim().length + 8) continue;
      // Hit area: the 44 x 44 box around the centre belongs to the control.
      const h = min / 2 - 1;
      const probes: Array<[number, number]> = [[-h, -h], [h, -h], [-h, h], [h, h]];
      const own = probes.every(([dx, dy]) => {
        const hit = document.elementFromPoint(cx + dx, cy + dy);
        return hit !== null && (hit === e || e.contains(hit) || (e.closest('label')?.contains(hit) ?? false));
      });
      if (own) continue;
      out.push({
        selector: describe(e),
        label: (e.getAttribute('aria-label') ?? e.textContent ?? e.getAttribute('title') ?? '').trim().replace(/\s+/g, ' ').slice(0, 40),
        size: `${box.width.toFixed(0)}x${box.height.toFixed(0)}`,
        where: where(e),
      });
    }
    return out;
  }, MIN);
}

function report(found: Map<string, Small & { state: string }>): string[] {
  return [...found.values()].map((s) => `[${s.where}] ${s.selector} "${s.label}" ${s.size} (${s.state})`);
}

test.describe('J11 tablet touch targets', () => {
  test.skip(() => test.info().project.name !== 'journeys-tablet', 'runs in the journeys-tablet project');

  for (const vp of VIEWPORTS) {
    test(`every control is at least 44 px at ${vp.name}`, async ({ page }, info) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/?test=1');
      expect(await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY), 'the large-touch layout query matches').toBe(true);
      const j = startJourney(page, info, 'j11');
      const found = new Map<string, Small & { state: string }>();
      const scan = async (state: string): Promise<void> => {
        await page.waitForTimeout(400);
        for (const s of await undersized(page)) {
          const key = `${s.selector}|${s.label}|${s.size}`;
          if (!found.has(key)) found.set(key, { ...s, state });
        }
      };

      await j.step('empty state', async () => {
        await page.goto('/?test=1');
        await expect(page.locator('.olv-empty')).toBeVisible();
        await scan('empty state');
      });
      const survey = await buildSurveyLas14();
      await j.step('open a scan', () => openWith(page, survey.bytes, 'survey-14.las'));
      await j.step('scene, dock and navigation card', () => scan('scene'));
      for (const mode of ['data', 'work', 'analyse', 'output'] as const) {
        await j.step(`${mode} tab`, async () => {
          await expect(page.locator(`.olv-ws-tab[data-mode="${mode}"]`)).toBeVisible();
          await showWorkspaceMode(page, mode);
          await scan(`${mode} tab`);
        });
      }
      await j.step('classified scan: class list', async () => {
        await openWith(page, fixtureBytes('terrain-access-utm.las'), 'terrain-access-utm.las');
        await openClassesPage(page);
        await expect(page.locator('.olv-class-panel .olv-cl-row').first()).toBeVisible({ timeout: 10_000 });
        await scan('class list');
      });
      await j.step('results shelf', async () => {
        const toggle = page.locator('.olv-results-toggle').first();
        await expect(toggle).toBeVisible();
        await toggle.click();
        await scan('results shelf');
      });
      await j.step('command palette', async () => {
        await page.keyboard.press('ControlOrMeta+KeyK');
        await expect(page.locator('.olv-palette')).toBeVisible();
        await scan('command palette');
        await page.keyboard.press('Escape');
      });
      await j.step('help overlay', async () => {
        await page.keyboard.press('Shift+Slash');
        await expect(page.locator('.olv-help-overlay')).toBeVisible();
        await scan('help overlay');
        await page.keyboard.press('Escape');
      });

      const lines = report(found);
      await info.attach('undersized-targets.txt', { body: lines.join('\n') || 'none', contentType: 'text/plain' });
      expect(lines, `controls smaller than ${MIN} x ${MIN} CSS px at ${vp.name}`).toEqual([]);
    });
  }

  test('the view cube is measured and stays clear of the open left rail', async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.goto('/?test=1&viewcube=1');
    expect(await page.evaluate((q) => matchMedia(q).matches, LARGE_TOUCH_LAYOUT_QUERY), 'the large-touch layout query matches').toBe(true);
    const j = startJourney(page, info, 'j11');
    await expect(page.locator('.olv-empty')).toBeVisible();
    const survey = await buildSurveyLas14();
    await j.step('open a scan with the view cube on', async () => {
      await dropBytes(page, survey.bytes, 'survey-14.las');
      await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
      await expect(page.locator('.olv-viewcube')).toBeVisible({ timeout: 20_000 });
    });
    await j.step('cube buttons are 44 px and clear of the rail and each other', async () => {
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => {
        const rect = (e: Element) => e.getBoundingClientRect();
        const cube = document.querySelector('.olv-viewcube') as HTMLElement;
        const cubeBox = rect(cube);
        const buttons = [...cube.querySelectorAll('button')].map((b) => rect(b));
        const small = buttons.filter((b) => b.width < 43.5 || b.height < 43.5).map((b) => `${b.width.toFixed(0)}x${b.height.toFixed(0)}`);
        // Circles: centres must be at least the sum of the radii apart.
        const overlaps: string[] = [];
        for (let i = 0; i < buttons.length; i++) for (let k = i + 1; k < buttons.length; k++) {
          const a = buttons[i], b = buttons[k];
          const d = Math.hypot(a.left + a.width / 2 - (b.left + b.width / 2), a.top + a.height / 2 - (b.top + b.height / 2));
          if (d < (a.width + b.width) / 2 - 1) overlaps.push(`${i}-${k} ${d.toFixed(1)}`);
        }
        const rail = document.querySelector('.olv-left-panels');
        const railOpen = !!rail && !rail.classList.contains('olv-rail-collapsed');
        const covered = railOpen ? [...rail!.children].filter((c) => rect(c).width > 0 && getComputedStyle(c).display !== 'none').filter((c) => {
          const b = rect(c);
          return b.left < cubeBox.right && b.right > cubeBox.left && b.top < cubeBox.bottom && b.bottom > cubeBox.top;
        }).map((c) => (c as HTMLElement).className) : [];
        return { n: buttons.length, small, overlaps, railOpen, covered, size: `${cubeBox.width.toFixed(0)}x${cubeBox.height.toFixed(0)}` };
      });
      await info.attach('viewcube.json', { body: JSON.stringify(r), contentType: 'application/json' });
      expect(r.n).toBe(5);
      expect(r.small, 'cube buttons under 44 px').toEqual([]);
      expect(r.overlaps, 'overlapping cube buttons').toEqual([]);
      expect(r.covered, 'rail panels overlapping the cube').toEqual([]);
    });
  });
});
