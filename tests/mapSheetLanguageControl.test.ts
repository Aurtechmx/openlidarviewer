/**
 * mapSheetLanguageControl.test.ts: the map sheet dialog's language choice is
 * off while the sheet style is Classic, says what stays in English, and the
 * dialog hands the session's language to the sheet it builds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

class Node0 {
  className = ''; id = ''; name = ''; type = ''; value = ''; checked = false; disabled = false; htmlFor = ''; title = ''; textContent = '';
  readonly children: Node0[] = [];
  private readonly listeners: Array<() => void> = [];
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  append(...kids: Node0[]): void { this.children.push(...kids); }
  setAttribute(): void { /* not read */ }
  addEventListener(type: string, fn: () => void): void { if (type === 'change') this.listeners.push(fn); }
  fire(): void { for (const fn of this.listeners) fn(); }
  querySelectorAll(): Node0[] {
    const walk = (n: Node0): Node0[] => n.children.flatMap((c) => [...(['INPUT', 'SELECT'].includes(c.tagName) ? [c] : []), ...walk(c)]);
    return walk(this);
  }
}

const had = (globalThis as { document?: unknown }).document;
beforeAll(() => { (globalThis as { document?: unknown }).document = { createElement: (t: string) => new Node0(t.toUpperCase()) }; });
afterAll(() => { (globalThis as { document?: unknown }).document = had; });

describe('the map sheet language choice', () => {
  it('is off while the sheet style is Classic, and says what stays in English', async () => {
    const { mapSheetLanguage } = await import('../src/ui/mapSheetLanguage');
    const style = new Node0('SELECT');
    style.value = 'light';
    const block = mapSheetLanguage(style as never) as unknown as Node0;
    const controls = block.querySelectorAll();
    expect(controls.length).toBeGreaterThanOrEqual(3);
    expect(controls.every((c) => !c.disabled)).toBe(true);
    style.value = 'classic'; style.fire();
    expect(controls.every((c) => c.disabled)).toBe(true);
    style.value = 'dark'; style.fire();
    expect(controls.every((c) => !c.disabled)).toBe(true);
    expect(block.children.map((c) => c.textContent).join(' ')).toMatch(/Classic sheet, the contour SVG and the PNG are in English/);
  });

  it('the dialog shows it under Sheet style and passes the language on', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'ui', 'AnalysePanel.ts'), 'utf8');
    expect(src).toMatch(/languageSlot\.append\(m\.mapSheetLanguage\(sheetStyleSel\)\)/);
    expect(src).toMatch(/field\('Sheet style'[^\n]*\n\s*languageSlot,/);
    expect(src).toMatch(/buildContourSheetPdf\(\{[\s\S]*?locale: exportLocale\(\)/);
  });
});
