/**
 * clipPanelNumericBounds.test.ts: the six numeric fields.
 *
 * A pair that is incomplete or reversed is never applied: the clip keeps its
 * last valid bounds and the panel says so. Bounds are shown at full precision.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ClipBox } from '../src/render/clip/clipBox';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

type Field = FakeEl & { value: string };

async function make(initial: ClipBox = { box: { min: [0, 0, 0], max: [10, 10, 10] }, mode: 'keep-inside', enabled: true }) {
  const { ClipPanel } = await import('../src/ui/ClipPanel');
  const applied: (ClipBox | null)[] = [];
  const panel = new ClipPanel({
    onApply: (c) => applied.push(c),
    fitBounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    keptCount: () => ({ kept: 1, total: 2 }),
  });
  panel.adoptBounds(initial);
  applied.length = 0;
  const root = panel.element as unknown as FakeEl;
  const nums = root.querySelectorAll('.olv-clip-num') as Field[];
  const error = () => root.querySelectorAll('.olv-clip-error')[0].textContent;
  const type = (i: number, v: string) => { nums[i].value = v; nums[i].dispatchEvent({ type: 'input' }); };
  // Field order: X min, X max, Y min, Y max, Z min, Z max.
  return { panel, applied, nums, error, type };
}

describe('numeric clip bounds', () => {
  it('does not apply a minimum above its maximum, and says why', async () => {
    const t = await make();
    t.type(0, '15');
    expect(t.applied).toEqual([]);
    expect(t.error()).toMatch(/X min is above X max/);
    expect(t.error()).toMatch(/keeps X 0 to 10/);
    expect(t.nums[0].getAttribute('aria-invalid')).toBe('true');
  });

  it('applies once the pair is valid again, using both fields', async () => {
    const t = await make();
    t.type(0, '15');
    t.type(1, '20');
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]?.box.min[0]).toBe(15);
    expect(t.applied[0]?.box.max[0]).toBe(20);
    expect(t.error()).toBe('');
    expect(t.nums[0].getAttribute('aria-invalid')).toBe('false');
  });

  it('keeps the last valid clip while a field is blank', async () => {
    const t = await make();
    t.type(2, '');
    expect(t.applied).toEqual([]);
    expect(t.error()).toMatch(/empty or not a number/);
    expect(t.error()).toMatch(/keeps Y 0 to 10/);
  });

  it('reports each axis separately and clears only the one that was fixed', async () => {
    const t = await make();
    t.type(0, '15');
    t.type(4, '');
    expect(t.error()).toMatch(/X min is above X max/);
    expect(t.error()).toMatch(/Z min or max is empty/);
    t.type(4, '2');
    expect(t.error()).toMatch(/X min is above X max/);
    expect(t.error()).not.toMatch(/Z min or max/);
  });

  it('accepts negative bounds and an equal minimum and maximum', async () => {
    const t = await make();
    t.type(0, '-5');
    t.type(1, '-5');
    expect(t.error()).toBe('');
    expect(t.applied.at(-1)?.box.min[0]).toBe(-5);
    expect(t.applied.at(-1)?.box.max[0]).toBe(-5);
  });

  it('shows a small stored boundary at full precision', async () => {
    const t = await make({ box: { min: [0.0004, -0.0004, 0], max: [1.2345678, 2, 3] }, mode: 'keep-inside', enabled: true });
    expect(t.nums[0].value).toBe('0.0004');
    expect(t.nums[2].value).toBe('-0.0004');
    expect(t.nums[1].value).toBe('1.2345678');
  });

  it('drops floating-point noise but not real digits', async () => {
    const t = await make({ box: { min: [0.1 + 0.2, 0, 0], max: [600000.123456, 1, 1] }, mode: 'keep-inside', enabled: true });
    expect(t.nums[0].value).toBe('0.3');
    expect(t.nums[1].value).toBe('600000.123456');
  });

  it('setting bounds from elsewhere clears a pending message', async () => {
    const t = await make();
    t.type(0, '15');
    t.panel.adoptBounds({ box: { min: [1, 1, 1], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true });
    expect(t.error()).toBe('');
    expect(t.nums[0].value).toBe('1');
  });
});
