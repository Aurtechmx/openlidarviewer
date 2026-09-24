/**
 * qualityControlLazyFailure.test.ts
 *
 * The Speed ↔ Quality control's chunk-load busy/failure states (LOAD-1 /
 * LAZY-1: OVERLAYS-LOAD-1 / OVERLAYS-LAZY-1). Companion to
 * `tests/speedQualityControlPanel.test.ts`'s happy-path coverage, which does
 * not mock `lazyChunks` (it dynamic-imports the real `QualityPanel`); this
 * file mocks `loadQualityPanel` specifically to drive the failure path.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { QualityDevice, QualityPreference } from '../src/render/quality/qualityPolicy';
import { DEFAULT_QUALITY_PREFERENCE } from '../src/ui/qualityPreferenceStore';

class FakeEl {
  readonly tagName: string;
  className = '';
  title = '';
  type = '';
  hidden = false;
  disabled = false;
  readonly children: FakeEl[] = [];
  private _text = '';
  private _html = '';
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

  readonly classList = {
    add: (c: string): void => { if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim(); },
    remove: (c: string): void => { this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' '); },
    toggle: (c: string, force?: boolean): void => {
      const want = force ?? !this.classList.contains(c);
      if (want) this.classList.add(c); else this.classList.remove(c);
    },
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };

  set textContent(v: string) { this._text = v; }
  get textContent(): string { return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' '); }
  set innerHTML(v: string) { this._html = v; }
  get innerHTML(): string { return this._html; }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  parent: FakeEl | null = null;
  append(...kids: Array<FakeEl | string>): void {
    for (const k of kids) { if (!(k instanceof FakeEl)) continue; k.parent = this; this.children.push(k); }
  }
  closest(selector: string): FakeEl | null {
    if (!selector.startsWith('.')) throw new Error(`FakeEl.closest: unsupported selector ${selector}`);
    const want = selector.slice(1);
    for (let node: FakeEl | null = this; node; node = node.parent) {
      if (node.className.split(/\s+/).includes(want)) return node;
    }
    return null;
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
  click(): void { this.fire('click'); }
  focus(): void {}
  contains(node: FakeEl): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
  one(cls: string): FakeEl {
    const found = this.findByClass(cls);
    if (found.length !== 1) throw new Error(`expected exactly one .${cls}, found ${found.length}`);
    return found[0];
  }
}

beforeAll(() => {
  const g = globalThis as unknown as { document: unknown; Node: unknown; HTMLInputElement: unknown; HTMLAnchorElement: unknown };
  g.Node = FakeEl;
  g.HTMLInputElement = FakeEl;
  g.HTMLAnchorElement = FakeEl;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

let loadResult: 'success' | 'reject' | 'undefined' | 'pending' = 'success';
let releasePending: (() => void) | null = null;
const QualityPanelCtor = vi.fn(function (this: { element: FakeEl; render: () => void }) {
  this.element = new FakeEl('div');
  this.element.className = 'olv-quality-pop';
  this.render = vi.fn();
});
vi.mock('../src/lazyChunks', () => ({
  loadQualityPanel: () => {
    if (loadResult === 'reject') return Promise.reject(new Error('chunk failed'));
    if (loadResult === 'undefined') return Promise.resolve(undefined);
    if (loadResult === 'pending') {
      return new Promise((resolve) => { releasePending = () => resolve({ QualityPanel: QualityPanelCtor }); });
    }
    return Promise.resolve({ QualityPanel: QualityPanelCtor });
  },
}));

const DESKTOP: QualityDevice = { tier: 'high', isMobile: false, backend: 'webgpu' };

function fakeToast() {
  const calls: Array<{ message: string; action?: { label: string; onClick: () => void } }> = [];
  return { show: (message: string, action?: { label: string; onClick: () => void }) => { calls.push({ message, action }); }, calls };
}

async function makeControl(toast?: ReturnType<typeof fakeToast>, preference: QualityPreference = DEFAULT_QUALITY_PREFERENCE) {
  const { QualityControl } = await import('../src/ui/qualityControl');
  const control = new QualityControl({
    device: DESKTOP,
    preference,
    onApply: () => {},
    ...(toast ? { toast } : {}),
  });
  return { control, root: control.element as unknown as FakeEl };
}

beforeEach(() => {
  loadResult = 'success';
  QualityPanelCtor.mockClear();
});

describe('QualityControl — busy state (LOAD-1)', () => {
  it('disables the button and sets aria-busy while the chunk is loading, clearing both on success', async () => {
    loadResult = 'pending';
    const { root, control } = await makeControl();
    const button = root.one('olv-quality-button');
    const openPromise = control.open();
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    releasePending?.();
    await openPromise;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(control.isOpen).toBe(true);
  });
});

describe('QualityControl — failure path (LAZY-1)', () => {
  it('reports a rejected chunk through the toast with a Try again action, and clears the busy state', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    const { root, control } = await makeControl(toast);
    const button = root.one('olv-quality-button');
    await control.open();
    expect(toast.calls).toHaveLength(1);
    expect(toast.calls[0].message).toBe('chunk failed');
    expect(toast.calls[0].action?.label).toBe('Try again');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(control.isOpen).toBe(false);
    expect(root.findByClass('olv-quality-pop')).toHaveLength(0);
  });

  it('reports the stale-chunk "resolves to undefined" case the same way', async () => {
    loadResult = 'undefined';
    const toast = fakeToast();
    const { control } = await makeControl(toast);
    await control.open();
    expect(toast.calls).toHaveLength(1);
    expect(control.isOpen).toBe(false);
  });

  it('falls back to console.error (never throws) when no toast is wired', async () => {
    loadResult = 'reject';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { control } = await makeControl(undefined);
    await expect(control.open()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a "Try again" action that succeeds actually opens the panel', async () => {
    loadResult = 'reject';
    const toast = fakeToast();
    const { root, control } = await makeControl(toast);
    await control.open();
    expect(toast.calls).toHaveLength(1);

    loadResult = 'success';
    toast.calls[0].action?.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(control.isOpen).toBe(true);
    expect(root.findByClass('olv-quality-pop')).toHaveLength(1);
  });
});
