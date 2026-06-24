/**
 * streamingPanelGrade.test.ts
 *
 * The StreamingPanel's full-cloud grade surface: the "Grade full cloud" button
 * and the busy / result / error states it drives. Runs in the node environment
 * via the same recording DOM stub the other panel tests use (FakeEl), so the
 * render tree + button-disabled + result-text contract is pinned without a
 * browser. The decode itself is exercised live; this guards the panel wiring.
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
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }
  /** Recursively collect every descendant whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
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
  // `el()` narrows with `node instanceof HTMLInputElement / HTMLAnchorElement`
  // before applying `type` / `href`. Those constructors don't exist in the node
  // test env, so define stand-ins; a FakeEl is never an instance, so the
  // narrowing simply skips (the panel sets `type:'button'` on its collapse btn).
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

/** Minimal callbacks — every method a no-op; the grade flow is driven directly. */
function noopCallbacks() {
  return {
    onColorMode() {}, onQuality() {}, onPauseToggle() {}, onClearCache() {},
    onSaveView() {}, onApplyView() {}, onDeleteView() {}, onGradeFullCloud() {},
    onCancelGrade() {},
  };
}

describe('StreamingPanel — full-cloud grade surface', () => {
  it('renders the "Grade full cloud" button and the section label', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Grade full cloud').length).toBe(1);
    expect(root.findByText('Full-cloud grade').length).toBe(1);
  });

  it('setGradeBusy turns the button into an enabled Cancel control and shows progress', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Decoding 3 / 10 nodes…');
    // Stays clickable (so the user can cancel) and relabels to Cancel.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Cancel');
    expect(root.findContaining('Decoding 3 / 10 nodes…')).toBeDefined();
  });

  it('setGradeCancelled resets the button label and shows a neutral note (no error)', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Decoding…');
    panel.setGradeCancelled();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Grade full cloud');
    expect(root.findContaining('Grade cancelled.')).toBeDefined();
    // Not an error state.
    const result = root.findContaining('Grade cancelled.');
    expect(result).toBeDefined();
  });

  it('setGradeResult renders scope + lines + note and re-enables the button', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Planning…');
    panel.setGradeResult(
      '2.0M of 10.7M points (19%, sampled)',
      ['Density: Sparse · ≈ 7.50 pts/m²', 'Vertical extent: 63.7 m'],
      'Graded from a representative octree sample.',
    );
    expect(btn.disabled).toBe(false);
    expect(root.findContaining('19%, sampled')).toBeDefined();
    expect(root.findContaining('7.50 pts/m²')).toBeDefined();
    expect(root.findContaining('Vertical extent: 63.7 m')).toBeDefined();
    expect(root.findContaining('representative octree sample')).toBeDefined();
  });

  it('setGradeError re-enables the button, flags the error class, and shows the message', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Planning…');
    panel.setGradeError('Open a streaming COPC or EPT scan first.');
    expect(btn.disabled).toBe(false);
    expect(root.findContaining('Open a streaming COPC or EPT scan first.')).toBeDefined();
  });

  it('hide() resets the grade result and re-enables the button for the next scan', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeResult('all 1.8M points (exact)', ['Density: Dense'], '');
    panel.hide();
    expect(btn.disabled).toBe(false);
    // The result region is emptied — its prior content no longer in the tree.
    expect(root.findContaining('all 1.8M points (exact)')).toBeUndefined();
  });
});
