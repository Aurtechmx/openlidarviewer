/**
 * clipPanelAdvanced.test.ts: the simplified Clip page. Primary controls are
 * Draw clipping box, Enable, Keep inside/Keep outside, Fit to scan and Turn off; the six
 * numeric fields sit in an Advanced disclosure that is closed by default, is
 * never rebuilt, and still drives the debounced apply and the generation-token
 * count.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ClipBox } from '../src/render/clip/clipBox';
import { clipScope } from '../src/render/clip/clipScope';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function make() {
  const { ClipPanel, CLIP_COUNT_DEBOUNCE_MS } = await import('../src/ui/ClipPanel');
  const applied: (ClipBox | null)[] = [];
  let kept = 10;
  const panel = new ClipPanel({
    onApply: (c) => applied.push(c),
    fitBounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    keptCount: () => ({ kept, total: 100 }),
  });
  const root = panel.element as unknown as FakeEl;
  const find = (sel: string) => root.querySelectorAll(sel);
  const pill = (text: string) => find('.olv-bc-pill').find((b) => b.textContent === text)!;
  return { panel, root, applied, find, pill, wait: CLIP_COUNT_DEBOUNCE_MS, setKept: (k: number) => { kept = k; } };
}

describe('Clip page: Advanced disclosure', () => {
  it('holds all six numeric fields, collapsed by default', async () => {
    const t = await make();
    const adv = t.find('details.olv-clip-advanced')[0];
    expect(adv).toBeDefined();
    expect(t.panel.advancedOpen).toBe(false);
    expect(adv.querySelectorAll('.olv-clip-num')).toHaveLength(6);
    // None of the primary controls live inside the disclosure.
    for (const text of ['Keep inside', 'Keep outside', 'Fit to scan', 'Turn off']) {
      expect(adv.querySelectorAll('.olv-bc-pill').some((b) => b.textContent === text)).toBe(false);
    }
    expect(adv.querySelectorAll('summary')[0].textContent).toBe('Advanced');
  });

  it('keeps the same nodes, values and state when toggled', async () => {
    const t = await make();
    t.panel.adoptBounds({ box: { min: [1, 2, 3], max: [4, 5, 6] }, mode: 'keep-inside', enabled: true });
    const before = t.find('.olv-clip-num');
    const adv = t.find('details.olv-clip-advanced')[0] as FakeEl & { open: boolean };
    adv.open = true;
    expect(t.panel.advancedOpen).toBe(true);
    adv.open = false;
    const after = t.find('.olv-clip-num');
    expect(after).toEqual(before);
    expect(after.every((n, i) => n === before[i])).toBe(true);
    expect(after.map((n) => (n as FakeEl & { value: string }).value)).toEqual(['1.000', '4.000', '2.000', '5.000', '3.000', '6.000']);
    // Adopting a clip does not pop the disclosure open.
    expect(t.panel.advancedOpen).toBe(false);
  });

  it('numeric steps still apply at once and count once after the debounce', async () => {
    const t = await make();
    t.panel.adoptBounds({ box: { min: [0, 0, 0], max: [1, 1, 1] }, mode: 'keep-inside', enabled: true });
    vi.advanceTimersByTime(t.wait);
    t.applied.length = 0;
    const nums = t.find('.olv-clip-num') as (FakeEl & { value: string })[];
    for (const v of ['2', '3']) {
      nums[1].value = v;
      nums[1].dispatchEvent({ type: 'input' });
    }
    expect(t.applied.map((c) => c?.box.max[0])).toEqual([2, 3]);
    t.setKept(42);
    vi.advanceTimersByTime(t.wait);
    expect(clipScope()).toEqual({ kept: 42, total: 100 });
    expect(t.find('.olv-export-fullres-hint')[0].textContent).toBe('42 of 100 points kept.');
  });
});

describe('Clip page: primary controls', () => {
  it('Turn off turns the clip off through the normal apply path and keeps the bounds', async () => {
    const t = await make();
    t.panel.adoptBounds({ box: { min: [1, 1, 1], max: [2, 2, 2] }, mode: 'keep-outside', enabled: true });
    t.applied.length = 0;
    expect(t.pill('Turn off').disabled).toBe(false);
    t.pill('Turn off').click();
    expect(t.panel.enabled).toBe(false);
    expect(t.applied).toEqual([null]);
    expect(clipScope()).toBeNull();
    const nums = t.find('.olv-clip-num') as (FakeEl & { value: string })[];
    expect(nums.map((n) => n.value)).toEqual(['1.000', '2.000', '1.000', '2.000', '1.000', '2.000']);
    // Off already: Turn off has nothing to do.
    expect(t.pill('Turn off').disabled).toBe(true);
  });

  it('Draw clipping box stays hidden until the shell wires it, then calls the handler', async () => {
    const t = await make();
    const draw = t.pill('Draw clipping box');
    expect(draw.classList.contains('olv-hidden')).toBe(true);
    const fn = vi.fn();
    t.panel.setOnDrawBox(fn);
    expect(draw.classList.contains('olv-hidden')).toBe(false);
    draw.click();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('subscribers hear every on/off and side change, and the unsubscribe works', async () => {
    const t = await make();
    const seen: Array<[boolean, string]> = [];
    const off = t.panel.subscribe(() => seen.push([t.panel.enabled, t.panel.mode]));
    t.panel.toggleEnabled();
    t.pill('Keep outside').click();
    t.pill('Turn off').click();
    t.panel.adoptBounds({ box: { min: [0, 0, 0], max: [1, 1, 1] }, mode: 'keep-inside', enabled: true });
    t.panel.setVisible(false);
    expect(seen).toEqual([
      [true, 'keep-inside'], [true, 'keep-outside'], [false, 'keep-outside'], [true, 'keep-inside'], [false, 'keep-inside'],
    ]);
    off();
    t.pill('Keep inside').click();
    expect(seen).toHaveLength(5);
  });
});
