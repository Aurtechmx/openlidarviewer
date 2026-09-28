/**
 * ceGlyphs.spec.ts: glyph-only state renders are pairwise distinct
 * (COMMUNITY_SPEC.md CE-STRIP-04).
 *
 * A state mark may be drawn as its glyph alone, beside words that name the row
 * rather than the state. The glyph then has to identify the state by shape:
 * no two states may share one. Two collisions existed: `withheld` drew the
 * `blocked` glyph, and the three reconstructed-origin confidences in the
 * Observatory drew one glyph between them.
 *
 * The first test reads the two glyph tables from source, so every state is
 * covered even where no fixture renders it. The second opens the surfaces
 * that draw state marks on a real scan and checks what the page shows: each
 * state class carries one glyph, and no glyph stands for two states.
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropTinyPtx, showWorkspaceMode, firePaletteAction } from './helpers';

const src = (rel: string): string => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** `key: 'glyph'` pairs of one object literal in a source file. */
function glyphTable(file: string, anchor: string, pattern: RegExp): Map<string, string> {
  const text = src(file);
  const start = text.indexOf(anchor);
  expect(start, `${anchor} not found in ${file}`).toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf('};', start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(pattern)) out.set(m[1], m[2]);
  return out;
}

test.describe('state glyphs', () => {
  test('every state glyph table maps each state to its own shape', () => {
    const sci = glyphTable('src/ui/stateChip.ts', 'export const STATE_GLYPH', /^\s*(\w+): '([^']+)'/gm);
    expect(sci.size).toBe(7);
    expect(new Set(sci.values()).size, JSON.stringify([...sci])).toBe(sci.size);
    expect(sci.get('withheld')).not.toBe(sci.get('blocked'));

    const origin = glyphTable('src/ui/observatory/stateChip.ts', 'const ORIGIN_CHIPS', /^\s*(\w+): \{ glyph: '([^']+)'/gm);
    const basis = glyphTable('src/ui/observatory/stateChip.ts', 'const BASIS_CHIPS', /^\s*'?([\w-]+)'?: \{ glyph: '([^']+)'/gm);
    const badges = [...origin.values(), ...basis.values()];
    expect(origin.size).toBe(5);
    expect(new Set(badges).size, JSON.stringify([...origin, ...basis])).toBe(badges.length);
  });

  test('the marks a scan draws keep one glyph per state', async ({ page }) => {
    test.slow();
    await page.goto('/?test=1');
    await dropTinyPtx(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    const seen = new Map<string, Set<string>>();
    const collect = async (scope: string): Promise<void> => {
      const marks = await page.locator(`${scope} .olv-state`).evaluateAll((nodes) => nodes.map((n) => ({
        state: (Array.from(n.classList).find((c) => c.startsWith('is-')) ?? '').slice(3),
        glyph: n.querySelector('.olv-state-glyph')?.textContent ?? '',
      })));
      for (const { state, glyph } of marks) {
        if (!seen.has(state)) seen.set(state, new Set());
        seen.get(state)!.add(glyph);
      }
    };
    const closeModal = async (page: Page): Promise<void> => {
      await page.keyboard.press('Escape');
      await expect(page.locator('.olv-modal')).toBeHidden();
    };

    await firePaletteAction(page, 'Dataset Story', 'Dataset Story');
    await expect(page.locator('.olv-modal')).toBeVisible();
    await collect('.olv-modal');
    await closeModal(page);
    await firePaletteAction(page, 'Export health', 'Export health check');
    await expect(page.locator('.olv-modal')).toBeVisible();
    await collect('.olv-modal');
    await closeModal(page);

    expect(seen.size, 'no state marks were drawn').toBeGreaterThan(0);
    const byGlyph = new Map<string, string>();
    for (const [state, glyphs] of seen) {
      expect(glyphs.size, `${state} drew ${[...glyphs].join(' ')}`).toBe(1);
      const glyph = [...glyphs][0];
      expect(byGlyph.get(glyph) ?? state, `${glyph} stands for ${byGlyph.get(glyph)} and ${state}`).toBe(state);
      byGlyph.set(glyph, state);
    }

    // The Observatory's origin and basis badges on the same scan.
    await showWorkspaceMode(page, 'analyse');
    await firePaletteAction(page, 'Observatory', 'Observatory (observation evidence)');
    const chips = page.locator('.olv-modal .olv-observatory-chip');
    await expect(chips.first()).toBeVisible({ timeout: 20_000 });
    const badges = await chips.evaluateAll((nodes) => nodes.map((n) => ({
      glyph: n.querySelector('.olv-observatory-chip-glyph')?.textContent ?? '',
      tip: n.getAttribute('data-tip') ?? n.getAttribute('title') ?? '',
    })));
    const glyphToTip = new Map<string, string>();
    for (const b of badges) {
      expect(glyphToTip.get(b.glyph) ?? b.tip, `${b.glyph} carries two meanings`).toBe(b.tip);
      glyphToTip.set(b.glyph, b.tip);
    }
  });
});
