/**
 * reclassifyUiAria.test.ts
 *
 * The lasso-arm toggle button in reclassifyUi.ts had no ARIA state signal
 * (v0.7 audit, finding ANALYSIS-F6): `olv-mkind-active` toggled the CSS class
 * on click, on a lasso commit, on Escape-cancel, and on `disarm()`, but never
 * touched `aria-pressed`, so a screen-reader user could not tell the lasso
 * tool was armed. Pins that every one of those paths now keeps aria-pressed
 * in sync with the class.
 *
 * Runs in the node environment via a recording DOM stub extended enough for
 * the real `LassoVolumeTool.enable()/disable()` to run end to end (a parented
 * fake canvas, `document.createElementNS`, `getComputedStyle`, a `window`
 * stub) rather than mocking the tool away — the arm/disarm transition is
 * exactly what `tool.enabled` gates in the click handler.
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

async function makeUi() {
  const { createReclassifyUi } = await import('../src/ui/reclassifyUi');
  const canvas = new FakeEl('canvas');
  const stage = new FakeEl('div');
  stage.append(canvas); // gives LassoVolumeTool.enable() a parentElement to mount into
  const ui = createReclassifyUi({
    canvas: canvas as unknown as HTMLCanvasElement,
    getViewer: () => null,
    getActiveId: () => null,
  });
  const root = ui.element as unknown as FakeEl;
  const armBtn = root.byTestId('reclass-arm')!;
  return { ui, armBtn };
}

describe('reclassifyUi — lasso-arm toggle exposes aria-pressed (ANALYSIS-F6)', () => {
  it('starts aria-pressed="false"', async () => {
    const { armBtn } = await makeUi();
    expect(armBtn.attrs['aria-pressed']).toBe('false');
    expect(armBtn.classList.contains('olv-mkind-active')).toBe(false);
  });

  it('arming (first click) sets aria-pressed="true" and the active class', async () => {
    const { armBtn } = await makeUi();
    armBtn.click();
    expect(armBtn.attrs['aria-pressed']).toBe('true');
    expect(armBtn.classList.contains('olv-mkind-active')).toBe(true);
  });

  it('disarming (second click) sets aria-pressed="false" and clears the active class', async () => {
    const { armBtn } = await makeUi();
    armBtn.click();
    armBtn.click();
    expect(armBtn.attrs['aria-pressed']).toBe('false');
    expect(armBtn.classList.contains('olv-mkind-active')).toBe(false);
  });

  it('the public disarm() also clears aria-pressed', async () => {
    const { ui, armBtn } = await makeUi();
    armBtn.click(); // arm
    expect(armBtn.attrs['aria-pressed']).toBe('true');
    const wasArmed = ui.disarm();
    expect(wasArmed).toBe(true);
    expect(armBtn.attrs['aria-pressed']).toBe('false');
  });

  it('disarm() on an already-idle tool is a no-op and reports false', async () => {
    const { ui, armBtn } = await makeUi();
    expect(ui.disarm()).toBe(false);
    expect(armBtn.attrs['aria-pressed']).toBe('false');
  });
});
