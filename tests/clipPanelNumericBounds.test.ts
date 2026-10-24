/**
 * clipPanelNumericBounds.test.ts: the six numeric fields.
 *
 *   - Typed text waits: an input event that carries text (an InputEvent) does
 *     not apply; Enter, the change event and leaving the field do.
 *   - Arrow keys and a wheel over the focused field step the bound and apply
 *     at once: 0.1 of the scene unit, 1 with Shift.
 *   - A pair that is incomplete or reversed is never applied: the clip keeps
 *     its last valid bounds and the message under the fields says so. Leaving
 *     the axis with such a value puts the last valid bounds back.
 *   - Bounds show three decimals; a field the user did not touch keeps its
 *     bound's full precision when its axis is applied.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { ClipBox } from '../src/render/clip/clipBox';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement ??= class {};
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  (globalThis as unknown as { document: Record<string, unknown> }).document.activeElement = undefined;
});

type Field = FakeEl & { value: string };

async function make(
  initial: ClipBox = { box: { min: [0, 0, 0], max: [10, 10, 10] }, mode: 'keep-inside', enabled: true },
  units: readonly [string, string, string] = ['m', 'm', 'm'],
) {
  const { ClipPanel } = await import('../src/ui/ClipPanel');
  const applied: (ClipBox | null)[] = [];
  const outlines: Array<{ box: unknown; active: boolean }> = [];
  const panel = new ClipPanel({
    onApply: (c) => applied.push(c),
    fitBounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    keptCount: () => ({ kept: 1, total: 2 }),
    onOutline: (box, active) => outlines.push({ box, active }),
    units: () => units,
  });
  panel.adoptBounds(initial);
  applied.length = 0;
  const root = panel.element as unknown as FakeEl;
  const nums = root.querySelectorAll('.olv-clip-num') as Field[];
  const error = () => root.querySelectorAll('.olv-clip-error')[0].textContent;
  /** Text typed into a field: an input event that carries an inputType. */
  const typeText = (i: number, v: string) => { nums[i].value = v; nums[i].dispatchEvent({ type: 'input', inputType: 'insertText' }); };
  /** Typed and committed (the change event Enter or a blur fires). */
  const type = (i: number, v: string) => { typeText(i, v); nums[i].dispatchEvent({ type: 'change' }); };
  const key = (i: number, k: string, shiftKey = false) => {
    const e = { type: 'keydown', key: k, shiftKey, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; }, stopPropagation() {} };
    nums[i].dispatchEvent(e);
    return e;
  };
  const blur = (i: number, to: FakeEl | null = null) => nums[i].dispatchEvent({ type: 'blur', relatedTarget: to });
  // Field order: X min, X max, Y min, Y max, Z min, Z max.
  return { panel, applied, outlines, nums, error, type, typeText, key, blur, root };
}

describe('typing does not apply until it is committed', () => {
  it('each typed character waits; the change event applies the whole value once', async () => {
    const t = await make();
    for (const v of ['3', '30', '300']) t.typeText(1, v);
    expect(t.applied).toEqual([]);
    expect(t.nums[1].classList.contains('is-pending')).toBe(true);
    t.nums[1].dispatchEvent({ type: 'change' });
    expect(t.applied).toHaveLength(1);
    expect(t.applied[0]?.box.max[0]).toBe(300);
    expect(t.nums[1].value).toBe('300.000');
    expect(t.nums[1].classList.contains('is-pending')).toBe(false);
  });

  it('Enter applies what was typed', async () => {
    const t = await make();
    t.typeText(3, '7.25');
    expect(t.applied).toEqual([]);
    const e = t.key(3, 'Enter');
    expect(e.defaultPrevented).toBe(true);
    expect(t.applied.at(-1)?.box.max[1]).toBe(7.25);
  });

  it('leaving the field applies a valid value', async () => {
    const t = await make();
    t.typeText(0, '2');
    t.blur(0);
    expect(t.applied.at(-1)?.box.min[0]).toBe(2);
  });

  it('a commit that changes nothing applies nothing', async () => {
    const t = await make();
    t.key(0, 'Enter');
    t.blur(0);
    expect(t.applied).toEqual([]);
  });
});

describe('arrow keys and the wheel step and apply at once', () => {
  it('ArrowUp steps 0.1 m and Shift+ArrowDown 1 m, each applied immediately', async () => {
    const t = await make();
    const e = t.key(1, 'ArrowUp');
    expect(e.defaultPrevented).toBe(true);
    expect(t.applied.at(-1)?.box.max[0]).toBeCloseTo(10.1, 9);
    expect(t.nums[1].value).toBe('10.100');
    t.key(1, 'ArrowDown', true);
    expect(t.applied.at(-1)?.box.max[0]).toBeCloseTo(9.1, 9);
    expect(t.applied).toHaveLength(2);
  });

  it('a step starts from the typed value when one is pending', async () => {
    const t = await make();
    t.typeText(1, '300');
    t.key(1, 'ArrowUp');
    expect(t.applied.at(-1)?.box.max[0]).toBeCloseTo(300.1, 9);
  });

  it('a wheel over the focused field steps it; over an unfocused one it does nothing', async () => {
    const t = await make();
    const wheel = (i: number, deltaY: number) => {
      const e = { type: 'wheel', deltaY, shiftKey: false, defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
      t.nums[i].dispatchEvent(e);
      return e;
    };
    expect(wheel(2, -100).defaultPrevented).toBe(false);
    expect(t.applied).toEqual([]);
    (globalThis as unknown as { document: Record<string, unknown> }).document.activeElement = t.nums[2];
    expect(wheel(2, -100).defaultPrevented).toBe(true);
    expect(t.applied.at(-1)?.box.min[1]).toBeCloseTo(0.1, 9);
    // Small trackpad deltas add up before they step.
    wheel(2, 20);
    expect(t.applied).toHaveLength(1);
    wheel(2, 40);
    expect(t.applied.at(-1)?.box.min[1]).toBeCloseTo(0, 9);
  });

  it('a wheel elsewhere on the panel ends the focused field\'s edit', async () => {
    const t = await make();
    let blurred = 0;
    t.nums[4].blur = () => { blurred++; };
    (globalThis as unknown as { document: Record<string, unknown> }).document.activeElement = t.nums[4];
    t.root.dispatchEvent({ type: 'wheel', target: t.root, deltaY: 50 });
    expect(blurred).toBe(1);
  });

  it('a scan in degrees steps about 0.1 m (0.000001°) and shows seven decimals', async () => {
    const t = await make({ box: { min: [10, 20, 0], max: [11, 21, 5] }, mode: 'keep-inside', enabled: true }, ['°', '°', 'm']);
    expect(t.nums[0].value).toBe('10.0000000');
    t.key(0, 'ArrowUp');
    expect(t.applied.at(-1)?.box.min[0]).toBeCloseTo(10.000001, 9);
    t.key(4, 'ArrowUp');
    expect(t.applied.at(-1)?.box.min[2]).toBeCloseTo(0.1, 9);
  });
});

describe('numeric clip bounds', () => {
  it('does not apply a minimum above its maximum, and says why', async () => {
    const t = await make();
    t.type(0, '15');
    expect(t.applied).toEqual([]);
    expect(t.error()).toMatch(/X min is above X max/);
    expect(t.error()).toMatch(/keeps X 0\.000 to 10\.000/);
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
    expect(t.error()).toMatch(/keeps Y 0\.000 to 10\.000/);
  });

  it('leaving a blank field puts the last valid bound back and says so', async () => {
    const t = await make();
    t.typeText(1, '');
    t.blur(1);
    expect(t.applied).toEqual([]);
    expect(t.nums[1].value).toBe('10.000');
    expect(t.nums[1].getAttribute('aria-invalid')).toBe('false');
    expect(t.error()).toMatch(/X is back to 0\.000 to 10\.000/);
  });

  it('moving to the axis\'s other field keeps a reversed pair open for fixing', async () => {
    const t = await make();
    t.type(0, '15');
    t.blur(0, t.nums[1]);
    expect(t.nums[0].value).toBe('15');
    t.type(1, '20');
    expect(t.applied.at(-1)?.box.min[0]).toBe(15);
  });

  it('Escape puts a typed axis back', async () => {
    const t = await make();
    t.typeText(0, '4');
    t.key(0, 'Escape');
    expect(t.nums[0].value).toBe('0.000');
    expect(t.applied).toEqual([]);
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

  it('shows three decimals, rounded outward, but keeps an untouched bound at full precision', async () => {
    const t = await make({ box: { min: [0.0004, -0.0004, 0.1 + 0.2], max: [1.2341, 2, 3] }, mode: 'keep-inside', enabled: true });
    // A minimum rounds down and a maximum up, so the shown box holds the applied one.
    expect(t.nums[0].value).toBe('0.000');
    expect(t.nums[2].value).toBe('-0.001');
    expect(t.nums[1].value).toBe('1.235');
    // Floating-point noise does not move a value a whole step.
    expect(t.nums[4].value).toBe('0.300');
    // Editing X max leaves X min at its stored 0.0004, not the 0.000 it shows.
    t.type(1, '2');
    expect(t.applied.at(-1)?.box.min[0]).toBe(0.0004);
    expect(t.applied.at(-1)?.box.max[0]).toBe(2);
  });

  it('setting bounds from elsewhere clears a pending message', async () => {
    const t = await make();
    t.type(0, '15');
    t.panel.adoptBounds({ box: { min: [1, 1, 1], max: [2, 2, 2] }, mode: 'keep-inside', enabled: true });
    expect(t.error()).toBe('');
    expect(t.nums[0].value).toBe('1.000');
  });
});

describe('frame and unit of the bounds', () => {
  it('names the local scene frame and its unit, and how the fields step', async () => {
    const t = await make();
    const frame = t.root.querySelectorAll('.olv-clip-frame')[0].textContent;
    expect(frame).toContain('local scene coordinates (m)');
    expect(frame).toContain('0.1 m, Shift 1 m');
    expect(frame).toContain('apply on Enter');
  });

  it('asserts no unit for a scan whose unit is unknown', async () => {
    const { frameText } = await import('../src/ui/ClipPanel');
    expect(frameText(['', '', ''])).toContain('(scene units)');
    expect(frameText(['', '', ''])).not.toContain(' m');
  });
});

describe('the box drawn in the scene', () => {
  it('shows while the clip is on or the page is open, and follows every applied bound', async () => {
    const t = await make();
    expect(t.outlines.at(-1)).toEqual({ box: { min: [0, 0, 0], max: [10, 10, 10] }, active: true });
    t.key(1, 'ArrowUp');
    expect((t.outlines.at(-1)?.box as { max: number[] }).max[0]).toBeCloseTo(10.1, 9);
    t.panel.clear();
    expect(t.outlines.at(-1)).toEqual({ box: null, active: false });
    t.panel.setPageOpen(true);
    expect(t.outlines.at(-1)?.box).not.toBeNull();
    expect(t.outlines.at(-1)?.active).toBe(false);
    t.panel.setPageOpen(false);
    expect(t.outlines.at(-1)?.box).toBeNull();
  });
});
