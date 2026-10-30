/**
 * autoClassifyRefusalNote.test.ts
 *
 * "Auto-classify scan" on a scan with producer classes refuses, and said why
 * only in a status message away from the button. The reason now shows as a
 * note beside the button, and the next click clears it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { makeFakeClassList } from './helpers/fakeClassList';

class FakeEl {
  className = '';
  title = '';
  type = '';
  value = '2';
  disabled = false;
  parentElement: FakeEl | null = null;
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private _text = '';
  private readonly _listeners: Record<string, (() => void)[]> = {};
  readonly classList = makeFakeClassList();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    for (const k of kids) {
      this.children.push(k);
      k.parentElement = this;
    }
  }
  remove(): void {
    if (!this.parentElement) return;
    const i = this.parentElement.children.indexOf(this);
    if (i >= 0) this.parentElement.children.splice(i, 1);
    this.parentElement = null;
  }
  addEventListener(type: string, handler: () => void): void {
    (this._listeners[type] ??= []).push(handler);
  }
  removeEventListener(type: string, handler: () => void): void {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }
  setPointerCapture(): void { /* no-op */ }
  click(): void { for (const h of this._listeners.click ?? []) h(); }
  /** Recursive lookup by data-testid, matching main.ts test API's pattern. */
  byTestId(id: string): FakeEl | undefined {
    if (this.attrs['data-testid'] === id) return this;
    for (const c of this.children) {
      const hit = c.byTestId(id);
      if (hit) return hit;
    }
    return undefined;
  }
}

beforeAll(() => {
  const documentElement = new FakeEl('html');
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    documentElement,
  };
  (globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = () => ({
    getPropertyValue: () => '',
  });
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener() { /* no-op */ },
    removeEventListener() { /* no-op */ },
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

async function makeUi(onAutoClassify: () => Promise<string | void>) {
  const { createReclassifyUi } = await import('../src/ui/reclassifyUi');
  const canvas = new FakeEl('canvas');
  new FakeEl('div').append(canvas);
  const ui = createReclassifyUi({
    canvas: canvas as unknown as HTMLCanvasElement,
    getViewer: () => null,
    getActiveId: () => null,
    onAutoClassify,
  });
  const root = ui.element as unknown as FakeEl;
  return { root, auto: root.byTestId('reclass-auto')!, note: () => root.byTestId('reclass-auto-note')! };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('auto-classify refusal shown beside the button', () => {
  it('shows the reason after a refused run and clears it on the next click', async () => {
    const reason = 'Classify · this scan carries producer classes, so they stay as they are. Press Clear classes first to replace them.';
    let refuse = true;
    const { auto, note } = await makeUi(async () => (refuse ? reason : undefined));
    expect(note().classList.contains('olv-hidden')).toBe(true);
    auto.click();
    await settle();
    expect(note().textContent).toBe(reason);
    expect(note().classList.contains('olv-hidden')).toBe(false);
    refuse = false;
    auto.click();
    await settle();
    expect(note().classList.contains('olv-hidden')).toBe(true);
  });
});
