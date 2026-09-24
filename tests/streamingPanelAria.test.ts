/**
 * streamingPanelAria.test.ts
 *
 * Pins the ARIA state the streaming panel's toggle controls must expose:
 *   - the mobile collapse chevron flips aria-expanded + its accessible name
 *     with the visual collapse, mirroring MobileSheet's handle (v0.7 audit
 *     finding INTAKE-F2);
 *   - the colour-mode and quality chip rows expose aria-pressed alongside
 *     the existing `olv-chip-active` CSS class, matching the codebase's
 *     established toggle-button convention (INTAKE-F4, StreamingPanel half);
 *   - the full-cloud grade result/error region is a role="status"
 *     aria-live="polite" live region, so an outcome reaching after the user
 *     looked away is still announced (INTAKE-F6).
 *
 * Runs in the node environment via the same recording DOM stub the other
 * StreamingPanel tests use (FakeEl), extended with an `attrs` record so
 * `setAttribute` calls — invisible to the other panel tests — are pinned
 * here.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ColorMode } from '../src/render/colorModes';
import { makeFakeClassList } from './helpers/fakeClassList';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attrs: Record<string, string> = {};
  private readonly _listeners: ((e: { target?: FakeEl; stopPropagation(): void }) => void)[] = [];
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
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids.filter(Boolean));
  }
  addEventListener(_type: string, handler: (e: { target?: FakeEl; stopPropagation(): void }) => void): void {
    this._listeners.push(handler);
  }
  blur(): void { /* no-op */ }
  click(): void {
    const evt = { target: this, stopPropagation(): void {} };
    for (const h of this._listeners) h(evt);
  }
  /** Every descendant carrying `cls`. */
  byClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.byClass(cls));
    return out;
  }
  /** Every descendant carrying the chip class, in row order. */
  chips(): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(' ').includes('olv-chip')) out.push(this);
    for (const c of this.children) out.push(...c.chips());
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

function callbacks() {
  return {
    onColorMode: vi.fn(),
    onQuality: vi.fn(),
    onPauseToggle: vi.fn(),
    onClearCache: vi.fn(),
    onGradeFullCloud: vi.fn(),
    onCancelGrade: vi.fn(),
  };
}

async function panel() {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const p = new StreamingPanel(callbacks());
  const root = p.element as unknown as FakeEl;
  return { panel: p, root };
}

describe('StreamingPanel — mobile collapse toggle a11y state (INTAKE-F2)', () => {
  it('starts expanded: aria-expanded="true", label "Collapse panel"', async () => {
    const { root } = await panel();
    const btn = root.byClass('olv-collapse-toggle')[0];
    expect(btn.attrs['aria-expanded']).toBe('true');
    expect(btn.attrs['aria-label']).toBe('Collapse panel');
  });

  it('clicking the chevron flips aria-expanded to "false" and the label to "Expand panel"', async () => {
    const { root } = await panel();
    const btn = root.byClass('olv-collapse-toggle')[0];
    btn.click();
    expect(btn.attrs['aria-expanded']).toBe('false');
    expect(btn.attrs['aria-label']).toBe('Expand panel');
    expect(root.classList.contains('olv-collapsed')).toBe(true);
  });

  it('clicking again restores the expanded state and label', async () => {
    const { root } = await panel();
    const btn = root.byClass('olv-collapse-toggle')[0];
    btn.click();
    btn.click();
    expect(btn.attrs['aria-expanded']).toBe('true');
    expect(btn.attrs['aria-label']).toBe('Collapse panel');
    expect(root.classList.contains('olv-collapsed')).toBe(false);
  });
});

const WITH_COLOUR: ColorMode[] = ['rgb', 'elevation'];

describe('StreamingPanel — colour-mode chips expose aria-pressed (INTAKE-F4)', () => {
  it('marks the active mode pressed and the rest not pressed', async () => {
    const { panel: p, root } = await panel();
    p.setColorModes(WITH_COLOUR, 'rgb');
    const chips = root.chips();
    const rgbChip = chips.find((c) => c.ownText === 'Color')!;
    const heightChip = chips.find((c) => c.ownText === 'Height')!;
    expect(rgbChip.attrs['aria-pressed']).toBe('true');
    expect(heightChip.attrs['aria-pressed']).toBe('false');
  });

  it('flips aria-pressed when the user clicks a different chip', async () => {
    const { root } = await panel();
    // Re-fetch panel since the outer `panel` name is shadowed above; use a
    // fresh instance here for clarity.
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const p = new StreamingPanel(callbacks());
    const r = p.element as unknown as FakeEl;
    p.setColorModes(WITH_COLOUR, 'rgb');
    const heightChip = r.chips().find((c) => c.ownText === 'Height')!;
    heightChip.click();
    const rgbChip = r.chips().find((c) => c.ownText === 'Color')!;
    expect(heightChip.attrs['aria-pressed']).toBe('true');
    expect(rgbChip.attrs['aria-pressed']).toBe('false');
    void root;
  });
});

describe('StreamingPanel — quality chips expose aria-pressed (INTAKE-F4)', () => {
  it('every quality chip is aria-pressed="false" before any selection', async () => {
    const { root } = await panel();
    const chips = root.byClass('olv-chip').filter((c) =>
      ['Low', 'Balanced', 'High'].includes(c.ownText));
    expect(chips).toHaveLength(3);
    for (const c of chips) expect(c.attrs['aria-pressed']).toBe('false');
  });

  it('setQuality marks the matching chip pressed and the others not', async () => {
    const { panel: p, root } = await panel();
    p.setQuality('high');
    const chips = root.byClass('olv-chip').filter((c) =>
      ['Low', 'Balanced', 'High'].includes(c.ownText));
    const high = chips.find((c) => c.ownText === 'High')!;
    const low = chips.find((c) => c.ownText === 'Low')!;
    expect(high.attrs['aria-pressed']).toBe('true');
    expect(low.attrs['aria-pressed']).toBe('false');
  });
});

describe('StreamingPanel — full-cloud grade result is a live region (INTAKE-F6)', () => {
  it('the grade-result node carries role="status" aria-live="polite" from construction', async () => {
    const { root } = await panel();
    const result = root.byClass('olv-streaming-grade-result')[0];
    expect(result.attrs['role']).toBe('status');
    expect(result.attrs['aria-live']).toBe('polite');
  });

  it('the live-region attributes survive a result render', async () => {
    const { panel: p, root } = await panel();
    p.setGradeResult('all 1.8M points (exact)', ['Density: Dense'], '');
    const result = root.byClass('olv-streaming-grade-result')[0];
    expect(result.attrs['role']).toBe('status');
    expect(result.attrs['aria-live']).toBe('polite');
    expect(result.textContent).toContain('all 1.8M points (exact)');
  });

  it('the live-region attributes survive an error render', async () => {
    const { panel: p, root } = await panel();
    p.setGradeError('Open a streaming COPC or EPT scan first.');
    const result = root.byClass('olv-streaming-grade-result')[0];
    expect(result.attrs['role']).toBe('status');
    expect(result.attrs['aria-live']).toBe('polite');
    expect(result.textContent).toContain('Open a streaming COPC or EPT scan first.');
  });
});
