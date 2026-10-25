/**
 * tests/streamingPanelResetForScan.test.ts
 *
 * What these tests would catch:
 *
 *  - A stream that replaced another stream inheriting the old panel's pause
 *    state, so the button read "Resume" over a scan that was streaming.
 *  - The old scan's full-cloud grade, or its running Cancel control, standing
 *    on the panel of the new scan.
 *  - The reset hiding the panel or dropping the new scan's summary.
 */

import { describe, it, expect, beforeAll } from 'vitest';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  readonly classList = {
    _set: new Set<string>(),
    add(c: string): void { this._set.add(c); },
    remove(c: string): void { this._set.delete(c); },
    toggle(c: string): void { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    contains(c: string): boolean { return this._set.has(c); },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids.filter(Boolean)); }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  blur(): void { /* no-op */ }
  click(): void { for (const fn of this.listeners.get('click') ?? []) fn(); }
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
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

async function panelWithToggles() {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const toggles: boolean[] = [];
  const panel = new StreamingPanel({
    onColorMode() {}, onQuality() {}, onPauseToggle(paused) { toggles.push(paused); }, onClearCache() {},
    onGradeFullCloud() {}, onCancelGrade() {},
  });
  const root = panel.element as unknown as FakeEl;
  return { panel, root, toggles, pause: root.findByText('Pause')[0]!, grade: root.findByText('Grade full cloud')[0]! };
}

describe('StreamingPanel.resetForScan', () => {
  it('returns the pause control and the grade to their starting state', async () => {
    const t = await panelWithToggles();
    t.panel.show();
    t.pause.click();
    expect(t.panel.paused).toBe(true);
    expect(t.pause.textContent).toBe('Resume');
    t.panel.setGradeBusy('Decoding 3 / 10 nodes…');
    expect(t.grade.textContent).toContain('Cancel');

    t.panel.resetForScan();

    expect(t.panel.paused).toBe(false);
    expect(t.pause.textContent).toBe('Pause');
    expect(t.grade.textContent).toBe('Grade full cloud');
    expect(t.grade.disabled).toBe(false);
    expect(t.root.findContaining('Decoding 3 / 10 nodes…')).toBeUndefined();
    // The reset describes the panel, not the renderer: no toggle is reported.
    expect(t.toggles).toEqual([true]);
  });

  it('keeps the panel shown and the new scan\'s summary', async () => {
    const t = await panelWithToggles();
    t.panel.show();
    t.panel.setSummary({ fileName: 'next.copc.laz', pointFormat: 6, sourcePoints: 10, width: 1, depth: 1, height: 1, spacing: 0.1, octreeDepth: 2, nodeCount: 3, format: 'copc', crs: null });
    t.panel.setGradeResult('all 10 points (exact)', ['Density: Dense'], '');

    t.panel.resetForScan();

    expect(t.root.classList.contains('olv-hidden')).toBe(false);
    expect(t.root.findContaining('next.copc.laz')).toBeDefined();
    expect(t.root.findContaining('all 10 points (exact)')).toBeUndefined();
  });
});
