/**
 * toastHost.test.ts
 *
 * The app's one toast, extracted from the shell. Pins what a caller relies on:
 * one live region created on first use, content replaced on every call, the
 * action button firing its callback, and the dismiss timer keyed to whether
 * an action is present.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createToastHost } from '../src/ui/panelChrome';

class FakeEl {
  className = '';
  type = '';
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classes = new Set<string>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(t: string, h: () => void): void { (this.listeners.get(t) ?? this.listeners.set(t, []).get(t)!).push(h); }
  click(): void { for (const h of this.listeners.get('click') ?? []) h(); }
  blur(): void {}
  get classList() {
    const c = this.classes;
    return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x), toggle: (x: string, on?: boolean) => { if (on ?? !c.has(x)) c.add(x); else c.delete(x); return c.has(x); } };
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

describe('createToastHost', () => {
  it('creates one live region on first use and reuses it', () => {
    const body = new FakeEl('body');
    const toast = createToastHost(() => body as unknown as HTMLElement);
    toast.show('one');
    toast.show('two');
    expect(body.children).toHaveLength(1);
    const root = body.children[0];
    expect(root.attrs.get('role')).toBe('status');
    expect(root.attrs.get('aria-live')).toBe('polite');
    expect(root.children.map((c) => c.textContent)).toEqual(['two']);
  });

  it('renders the action as a button that fires the callback, and drops it on the next info toast', () => {
    const body = new FakeEl('body');
    const toast = createToastHost(() => body as unknown as HTMLElement);
    const onClick = vi.fn();
    toast.show('save?', { label: 'Save', onClick });
    const root = body.children[0];
    const btn = root.children.find((c) => c.tagName === 'button')!;
    expect(btn.textContent).toBe('Save');
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    toast.show('done');
    expect(root.children.some((c) => c.tagName === 'button')).toBe(false);
  });

  it('dismisses after 6 s for a message and 8 s when an action is present', () => {
    vi.useFakeTimers();
    try {
      const body = new FakeEl('body');
      const toast = createToastHost(() => body as unknown as HTMLElement);
      toast.show('info');
      const root = body.children[0];
      vi.advanceTimersByTime(5_999);
      expect(root.classes.has('olv-visible')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(root.classes.has('olv-visible')).toBe(false);
      toast.show('act', { label: 'Go', onClick: () => {} });
      vi.advanceTimersByTime(7_999);
      expect(root.classes.has('olv-visible')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(root.classes.has('olv-visible')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
