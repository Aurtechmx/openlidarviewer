/**
 * exportLanguageControl.test.ts
 *
 * The Language and Numbers control sets the session's export language and
 * number style, every copy follows a change made in another, and copies are
 * held weakly behind one subscription.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

class Node0 {
  className = '';
  id = '';
  name = '';
  type = '';
  value = '';
  checked = false;
  htmlFor = '';
  title = '';
  textContent = '';
  readonly children: Node0[] = [];
  readonly tagName: string;
  private readonly attrs = new Map<string, string>();
  private readonly changes: Array<() => void> = [];
  constructor(tagName: string) { this.tagName = tagName; }
  append(...kids: Node0[]): void { this.children.push(...kids); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: () => void): void { if (type === 'change') this.changes.push(fn); }
  fire(): void { for (const fn of this.changes) fn(); }
}

const all = (root: Node0, tag: string): Node0[] => {
  const out: Node0[] = [];
  const walk = (n: Node0): void => { if (n.tagName === tag) out.push(n); n.children.forEach(walk); };
  walk(root);
  return out;
};
const select = (root: Node0): Node0 => all(root, 'SELECT')[0];
const numbers = (root: Node0): string | undefined => all(root, 'INPUT').find((i) => i.checked)?.value;

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new Node0(tag.toUpperCase()),
  };
});

describe('export language control', () => {
  afterEach(async () => {
    (await import('../src/i18n/exportLocale')).setExportLanguage('en');
  });

  it('lists every language by its own name, drafts marked, and starts on English with point decimals', async () => {
    const { exportLanguageControl } = await import('../src/ui/exportLanguageControl');
    const block = exportLanguageControl('Applies to the report.') as unknown as Node0;
    const options = all(block, 'OPTION').map((o) => `${o.value}:${o.textContent}`);
    expect(options).toEqual([
      'en:English',
      'es:Español (México) (draft)',
      'pt:Português (Brasil) (draft)',
      'fr:Français (draft)',
      'de:Deutsch (draft)',
    ]);
    expect(select(block).value).toBe('en');
    expect(numbers(block)).toBe('point');
  });

  it('a language picked in one copy shows in the others, with its usual number style', async () => {
    const { exportLanguageControl } = await import('../src/ui/exportLanguageControl');
    const { exportLocale } = await import('../src/i18n/exportLocale');
    const a = exportLanguageControl('x') as unknown as Node0;
    const b = exportLanguageControl('x') as unknown as Node0;
    select(a).value = 'pt';
    select(a).fire();
    expect(exportLocale()).toEqual({ lang: 'pt', numberStyle: 'comma' });
    expect(select(b).value).toBe('pt');
    expect(numbers(b)).toBe('comma');
  });

  it('the number style is chosen on its own and keeps the language', async () => {
    const { exportLanguageControl } = await import('../src/ui/exportLanguageControl');
    const { exportLocale, setExportLanguage } = await import('../src/i18n/exportLocale');
    setExportLanguage('es');
    const block = exportLanguageControl('x') as unknown as Node0;
    const comma = all(block, 'INPUT').find((i) => i.value === 'comma')!;
    comma.checked = true;
    comma.fire();
    expect(exportLocale()).toEqual({ lang: 'es', numberStyle: 'comma' });
  });

  it('holds each copy weakly behind one subscription', async () => {
    const { exportLanguageControl, exportLanguageControlCount } = await import('../src/ui/exportLanguageControl');
    const before = exportLanguageControlCount();
    exportLanguageControl('x');
    expect(exportLanguageControlCount()).toBe(before + 1);
    const src = (await import('node:fs')).readFileSync(new URL('../src/ui/exportLanguageControl.ts', import.meta.url), 'utf8');
    expect(src).toContain('new WeakRef(block)');
    expect(src.match(/onExportLocaleChange\(/g)).toHaveLength(1);
  });
});
