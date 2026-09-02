/**
 * panelViewStatus.test.ts
 *
 * `StreamingPanel.setViewStatus` renders the current-view model and nothing
 * else decides the bar. The guard that matters is reversibility: the old panel
 * latched a terminal 100% on the phase string "Streaming ready" and early-
 * returned from every later update, so a camera move into unloaded terrain
 * still read complete. Ready must now be revocable by the next snapshot.
 *
 * Runs in the node environment on the same recording DOM stub the other panel
 * tests use.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { StreamingViewStatus } from '../src/ui/streamingViewStatus';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    _set: new Set<string>(),
    add(c: string): void { this._set.add(c); },
    remove(c: string): void { this._set.delete(c); },
    toggle(c: string, on?: boolean): void {
      const want = on ?? !this._set.has(c);
      if (want) this._set.add(c); else this._set.delete(c);
    },
    contains(c: string): boolean { return this._set.has(c); },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids.filter(Boolean));
  }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** First descendant carrying `cls`, or undefined. */
  byClass(cls: string): FakeEl | undefined {
    if (this.className.split(' ').includes(cls)) return this;
    for (const c of this.children) {
      const hit = c.byClass(cls);
      if (hit) return hit;
    }
    return undefined;
  }
  /** First descendant whose own text contains `substr`, or undefined. */
  findContaining(substr: string): FakeEl | undefined {
    if (this._text.includes(substr)) return this;
    for (const c of this.children) {
      const hit = c.findContaining(substr);
      if (hit) return hit;
    }
    return undefined;
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

function noopCallbacks() {
  return {
    onColorMode() {}, onQuality() {}, onPauseToggle() {}, onClearCache() {},
    onGradeFullCloud() {}, onCancelGrade() {},
  };
}

function model(over: Partial<StreamingViewStatus>): StreamingViewStatus {
  return {
    state: 'loading',
    headline: 'Loading current view…',
    fraction: 0.5,
    determinate: true,
    detail: '5 / 10 requested nodes resident',
    tone: 'progress',
    ...over,
  };
}

async function makePanel() {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const panel = new StreamingPanel(noopCallbacks());
  return { panel, root: panel.element as unknown as FakeEl };
}

describe('StreamingPanel — current-view readiness line', () => {
  it('renders the headline, the detail and a determinate fill', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(model({}));
    expect(root.findContaining('Loading current view…')).toBeDefined();
    expect(root.findContaining('5 / 10 requested nodes resident')).toBeDefined();
    expect(root.byClass('olv-stream-prog-fill')?.style.width).toBe('50%');
    expect(root.byClass('olv-stream-prog-track')?.attrs['aria-valuenow']).toBe('50');
  });

  it('shows no percentage at all when the view is indeterminate', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({ state: 'unknown', headline: 'Establishing current view…', fraction: null, determinate: false, detail: '' }),
    );
    const track = root.byClass('olv-stream-prog-track');
    expect(track?.classList.contains('olv-stream-prog-shimmer')).toBe(true);
    expect(track?.attrs['aria-valuenow']).toBeUndefined();
  });

  it('revokes ready when the next snapshot reports a new wanted set', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({ state: 'settled', headline: 'Current view ready', fraction: 1, detail: '20 / 20 requested nodes resident', tone: 'ready' }),
    );
    expect(root.byClass('olv-stream-prog-fill')?.style.width).toBe('100%');

    // Camera moved: 50 wanted, 20 resident. Nothing may hold the bar at 100%.
    panel.setViewStatus(model({ fraction: 0.4, detail: '20 / 50 requested nodes resident' }));
    expect(root.byClass('olv-stream-prog-fill')?.style.width).toBe('40%');
    expect(root.findContaining('Current view ready')).toBeUndefined();
    expect(root.findContaining('20 / 50 requested nodes resident')).toBeDefined();
  });

  it('marks a view holding failed nodes without ever saying ready', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({
        state: 'incomplete',
        headline: 'Current view incomplete — 2 requested nodes could not load',
        fraction: 0.9,
        detail: '18 / 20 requested nodes resident',
        tone: 'warn',
      }),
    );
    expect(root.findContaining('Current view incomplete — 2 requested nodes could not load')).toBeDefined();
    expect(root.findContaining('Current view ready')).toBeUndefined();
    expect(root.byClass('olv-stream-prog-fill')?.style.width).toBe('90%');
  });

  it('reports whether the user has paused streaming', async () => {
    const { panel } = await makePanel();
    expect(panel.paused).toBe(false);
  });
});
