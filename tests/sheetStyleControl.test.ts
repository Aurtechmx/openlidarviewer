/**
 * sheetStyleControl.test.ts
 *
 * The Sheet style control sets the session style the exports read, every
 * control on the page follows a change made in another one, and a control
 * that has left the page stops listening.
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
  isConnected = true;
  readonly children: Node0[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly changes: Array<() => void> = [];
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  append(...kids: Node0[]): void { this.children.push(...kids); }
  setAttribute(k: string, v: string): void { this.attrs.set(k, v); }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  addEventListener(type: string, fn: () => void): void { if (type === 'change') this.changes.push(fn); }
  pick(): void { this.checked = true; for (const fn of this.changes) fn(); }
}

function radios(root: Node0): Node0[] {
  const out: Node0[] = [];
  const walk = (n: Node0): void => {
    if (n.tagName === 'INPUT') out.push(n);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
}
const checkedValue = (root: Node0): string | undefined => radios(root).find((r) => r.checked)?.value;

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new Node0(tag.toUpperCase()),
  };
});

describe('sheet style control', () => {
  afterEach(async () => {
    (await import('../src/export/sheetKit/sessionStyle')).setSheetStyle('light');
  });

  it('starts on the session style and offers Light, Dark and Classic', async () => {
    const { sheetStyleControl } = await import('../src/ui/sheetStyleControl');
    const row = sheetStyleControl() as unknown as Node0;
    expect(radios(row).map((r) => r.value)).toEqual(['light', 'dark', 'classic']);
    expect(checkedValue(row)).toBe('light');
    expect(row.textContent).toBe('');
    expect(row.children[0].textContent).toBe('Sheet style');
  });

  it('a pick sets the style the exports read, and other controls follow', async () => {
    const { sheetStyleControl } = await import('../src/ui/sheetStyleControl');
    const { sheetStyle } = await import('../src/export/sheetKit/sessionStyle');
    const a = sheetStyleControl() as unknown as Node0;
    const b = sheetStyleControl() as unknown as Node0;
    radios(a).find((r) => r.value === 'dark')!.pick();
    expect(sheetStyle()).toBe('dark');
    expect(checkedValue(b)).toBe('dark');
    expect(radios(b).filter((r) => r.checked)).toHaveLength(1);
  });

  it('follows a change made in the map sheet dialog', async () => {
    const { sheetStyleControl } = await import('../src/ui/sheetStyleControl');
    const { setSheetStyle } = await import('../src/export/sheetKit/sessionStyle');
    const row = sheetStyleControl() as unknown as Node0;
    setSheetStyle('classic');
    expect(checkedValue(row)).toBe('classic');
  });

  it('a control taken off the page stops listening', async () => {
    const { sheetStyleControl } = await import('../src/ui/sheetStyleControl');
    const { setSheetStyle } = await import('../src/export/sheetKit/sessionStyle');
    const row = sheetStyleControl() as unknown as Node0;
    setSheetStyle('dark');
    row.isConnected = false;
    setSheetStyle('classic');
    row.isConnected = true;
    setSheetStyle('light');
    expect(checkedValue(row)).toBe('dark');
  });
});
