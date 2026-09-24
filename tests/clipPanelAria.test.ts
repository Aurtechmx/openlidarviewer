/**
 * clipPanelAria.test.ts
 *
 * ClipPanel had no unit test coverage before this file (v0.7 audit,
 * findings ANALYSIS-F4 / ANALYSIS-F5). Pins:
 *   - the Inside/Outside mode buttons expose aria-pressed alongside the
 *     existing `is-active` CSS class, both on click and on `setState`
 *     (a session-restore path that skips the click handler);
 *   - the "kept of total" readout is a role="status" aria-live="polite"
 *     live region from construction, so an extent edit's outcome reaches a
 *     screen-reader user without them re-reading the panel.
 *
 * Runs in the node environment via the same recording DOM stub the other
 * panel tests use (FakeEl records `setAttribute` into `.attrs` and captures
 * click listeners).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { ClipBox } from '../src/render/clip/clipBox';
import type { ClipPanelCallbacks } from '../src/ui/ClipPanel';
import { makeFakeClassList } from './helpers/fakeClassList';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  checked = false;
  value = '';
  step = '';
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
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
  get ownText(): string { return this._text; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  addEventListener(type: string, handler: () => void): void {
    (this._listeners[type] ??= []).push(handler);
  }
  click(): void { for (const h of this._listeners.click ?? []) h(); }
  /** Every descendant (incl. self) carrying `cls`. */
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

function noopCallbacks(): ClipPanelCallbacks {
  return {
    onApply: () => {},
    fitBounds: () => null,
    keptCount: () => null,
  };
}

async function makePanel(cb: ClipPanelCallbacks = noopCallbacks()) {
  const { ClipPanel } = await import('../src/ui/ClipPanel');
  const panel = new ClipPanel(cb);
  const root = panel.element as unknown as FakeEl;
  return { panel, root };
}

describe('ClipPanel — mode buttons expose aria-pressed (ANALYSIS-F4)', () => {
  it('Inside starts pressed, Outside does not', async () => {
    const { root } = await makePanel();
    const inside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Inside')!;
    const outside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Outside')!;
    expect(inside.attrs['aria-pressed']).toBe('true');
    expect(outside.attrs['aria-pressed']).toBe('false');
  });

  it('clicking Outside flips aria-pressed on both buttons', async () => {
    const { root } = await makePanel();
    const inside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Inside')!;
    const outside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Outside')!;
    outside.click();
    expect(outside.attrs['aria-pressed']).toBe('true');
    expect(inside.attrs['aria-pressed']).toBe('false');
  });

  it('setState (session restore) updates aria-pressed without a click', async () => {
    const { panel, root } = await makePanel();
    const clip: ClipBox = {
      box: { min: [0, 0, 0], max: [1, 1, 1] },
      mode: 'keep-outside',
      enabled: true,
    };
    panel.setState(clip);
    const inside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Inside')!;
    const outside = root.byClass('olv-bc-pill').find((b) => b.textContent === 'Outside')!;
    expect(outside.attrs['aria-pressed']).toBe('true');
    expect(inside.attrs['aria-pressed']).toBe('false');
  });
});

describe('ClipPanel — "kept of total" readout is a live region (ANALYSIS-F5)', () => {
  it('carries role="status" aria-live="polite" from construction', async () => {
    const { root } = await makePanel();
    const readout = root.byClass('olv-export-fullres-hint')[0];
    expect(readout.attrs['role']).toBe('status');
    expect(readout.attrs['aria-live']).toBe('polite');
  });

  it('the live-region attributes survive an extent-driven readout update', async () => {
    const cb = {
      onApply: () => {},
      fitBounds: () => null,
      keptCount: () => ({ kept: 42, total: 100 }),
    };
    const { panel, root } = await makePanel(cb);
    panel.setState({ box: { min: [0, 0, 0], max: [1, 1, 1] }, mode: 'keep-inside', enabled: true });
    const readout = root.byClass('olv-export-fullres-hint')[0];
    expect(readout.attrs['role']).toBe('status');
    expect(readout.attrs['aria-live']).toBe('polite');
    expect(readout.textContent).toBe('42 of 100 points kept.');
  });
});
