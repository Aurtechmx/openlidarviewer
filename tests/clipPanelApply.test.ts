/**
 * clipPanelApply.test.ts — ClipPanel's apply path (spec 6B) and its public
 * `adoptBounds` entry used by "Use as clipping region" (spec 3).
 *
 *   - geometry reaches the renderer on EVERY valid edit, immediately;
 *   - only the kept-point count is debounced, and the readout says it is
 *     updating meanwhile (never the old number as current);
 *   - a generation token drops a pending count on any newer change, hide,
 *     invalidation or dispose, so a stale count never lands;
 *   - adoptBounds syncs checkbox, numeric bounds, mode and readout.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ClipBox } from '../src/render/clip/clipBox';
import { clipScope } from '../src/render/clip/clipScope';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function make() {
  const { ClipPanel, CLIP_COUNT_DEBOUNCE_MS } = await import('../src/ui/ClipPanel');
  const applied: (ClipBox | null)[] = [];
  let counts = 0;
  let kept = 10;
  const panel = new ClipPanel({
    onApply: (c) => applied.push(c),
    fitBounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    keptCount: () => { counts++; return { kept, total: 100 }; },
  });
  const root = panel.element as unknown as FakeEl;
  const readout = root.querySelectorAll('.olv-export-fullres-hint')[0];
  const inputs = root.querySelectorAll('.olv-clip-num') as unknown as (FakeEl & { value: string })[];
  const checkbox = root.querySelectorAll('.olv-clip-enable')[0].querySelectorAll('input')[0] as unknown as { checked: boolean };
  applied.length = 0;
  return {
    panel, applied, readout, inputs, checkbox, wait: CLIP_COUNT_DEBOUNCE_MS,
    counts: () => counts, setKept: (k: number) => { kept = k; },
  };
}

const clip = (min: number[], max: number[], mode: ClipBox['mode'] = 'keep-inside'): ClipBox =>
  ({ box: { min: min as [number, number, number], max: max as [number, number, number] }, mode, enabled: true });

describe('ClipPanel.adoptBounds', () => {
  it('goes through the normal apply path and syncs every control', async () => {
    const t = await make();
    t.panel.adoptBounds(clip([1, 2, 3], [4, 5, 6]));
    expect(t.applied).toEqual([clip([1, 2, 3], [4, 5, 6])]);
    expect(t.panel.enabled).toBe(true);
    expect(t.panel.element.classList.contains('olv-collapsed')).toBe(false);
    expect(t.checkbox.checked).toBe(true);
    // min/max inputs are laid out X min, X max, Y min, ...
    expect(t.inputs.map((i) => i.value)).toEqual(['1', '4', '2', '5', '3', '6']);
    vi.advanceTimersByTime(t.wait);
    expect(t.readout.textContent).toBe('10 of 100 points kept.');
    expect(clipScope()).toEqual({ kept: 10, total: 100 });
  });

  it('then behaves like any clip: Outside switch and numeric edits re-apply', async () => {
    const t = await make();
    t.panel.adoptBounds(clip([0, 0, 0], [1, 1, 1]));
    const outside = (t.panel.element as unknown as FakeEl).querySelectorAll('.olv-bc-pill').find((b) => b.textContent === 'Outside')!;
    outside.click();
    expect(t.applied.at(-1)?.mode).toBe('keep-outside');
    t.inputs[1].value = '7';
    t.inputs[1].dispatchEvent({ type: 'input' });
    expect(t.applied.at(-1)?.box.max[0]).toBe(7);
    expect(t.applied.at(-1)?.mode).toBe('keep-outside');
  });
});

describe('ClipPanel responsiveness (spec 6B)', () => {
  it('applies geometry immediately on every edit and counts once after a burst', async () => {
    const t = await make();
    t.panel.adoptBounds(clip([0, 0, 0], [1, 1, 1]));
    const base = t.counts();
    t.applied.length = 0;
    for (const v of ['2', '3', '4']) {
      t.inputs[1].value = v;
      t.inputs[1].dispatchEvent({ type: 'input' });
    }
    expect(t.applied.map((c) => c?.box.max[0])).toEqual([2, 3, 4]);
    expect(t.readout.textContent).toBe('Updating kept-point count…');
    vi.advanceTimersByTime(t.wait);
    expect(t.counts()).toBe(base + 1);
    expect(t.readout.textContent).toBe('10 of 100 points kept.');
  });

  it('a newer edit supersedes a pending count; the old number never shows as current', async () => {
    const t = await make();
    t.panel.adoptBounds(clip([0, 0, 0], [1, 1, 1]));
    vi.advanceTimersByTime(t.wait);
    t.setKept(55);
    t.panel.adoptBounds(clip([0, 0, 0], [2, 2, 2]));
    expect(t.readout.textContent).not.toContain('10 of 100');
    vi.advanceTimersByTime(t.wait - 1);
    t.setKept(77);
    t.panel.adoptBounds(clip([0, 0, 0], [3, 3, 3]));
    vi.advanceTimersByTime(t.wait);
    expect(t.readout.textContent).toBe('77 of 100 points kept.');
  });

  it('hide, dispose and setState drop a pending count', async () => {
    for (const kill of ['hide', 'dispose', 'restore'] as const) {
      const t = await make();
      t.panel.adoptBounds(clip([0, 0, 0], [1, 1, 1]));
      const before = t.counts();
      if (kill === 'hide') t.panel.setVisible(false);
      else if (kill === 'dispose') t.panel.dispose();
      else t.panel.setState({ ...clip([0, 0, 0], [1, 1, 1]), enabled: false });
      vi.advanceTimersByTime(t.wait * 2);
      expect(t.counts()).toBe(before);
    }
  });

  it('invalidateCount recounts against the new data', async () => {
    const t = await make();
    t.panel.adoptBounds(clip([0, 0, 0], [1, 1, 1]));
    vi.advanceTimersByTime(t.wait);
    t.setKept(3);
    t.panel.invalidateCount();
    expect(t.readout.textContent).toBe('10 of 100 points kept.');
    vi.advanceTimersByTime(t.wait);
    expect(t.readout.textContent).toBe('3 of 100 points kept.');
  });
});
