/**
 * floorPlanExportOptions.test.ts
 *
 * WIN 1 — the ObjectPanel "Floor plan options" control (v0.4.7). The control
 * exposes a 3-segment "Walls" picker (Auto / Square / As-is → snap auto /
 * strong / off) and an "Adaptive height" toggle. This pins:
 *
 *   1. the control defaults match the headless FLOOR_PLAN_EXPORT_DEFAULTS
 *      (which mirror main.ts FLOORPLAN_OPTIONS), so an export taken before any
 *      interaction uses the same settings the feature was plumbed against;
 *   2. selecting a segment / toggling the checkbox flows straight into the
 *      object returned by panel.floorPlanOptions() — the exact object the host
 *      spreads into extractFloorPlan()'s FloorPlanParams for BOTH export paths.
 *
 * Runs in the node environment via a recording DOM stub that dispatches the
 * 'change' listeners the control registers (the base ObjectPanel stub elsewhere
 * is no-op on events; here we need the events to fire).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { SnapMode } from '../src/terrain/space/floorplan/vectorize';

/** A fake element that records its registered listeners so we can dispatch. */
class FakeEl {
  className = '';
  title = '';
  type = '';
  id = '';
  name = '';
  value = '';
  htmlFor = '';
  checked = false;
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = { toggle(): void {}, add(): void {}, remove(): void {} };
  readonly tagName: string;
  private readonly _listeners = new Map<string, Array<() => void>>();
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void {}
  removeAttribute(): void {}
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: () => void): void {
    const arr = this._listeners.get(type) ?? [];
    arr.push(fn);
    this._listeners.set(type, arr);
  }
  /** Fire the registered listeners of a type (after the caller sets state). */
  dispatch(type: string): void {
    for (const fn of this._listeners.get(type) ?? []) fn();
  }
  /** Depth-first find the first descendant matching a predicate. */
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined {
    if (pred(this)) return this;
    for (const c of this.children) {
      const hit = c.find(pred);
      if (hit) return hit;
    }
    return undefined;
  }
  findAll(pred: (e: FakeEl) => boolean, acc: FakeEl[] = []): FakeEl[] {
    if (pred(this)) acc.push(this);
    for (const c of this.children) c.findAll(pred, acc);
    return acc;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

/** A minimal interior room shell (4 walls, floor, ceiling). */
function room(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
  return Float32Array.from(t);
}

async function makeInteriorPanel(): Promise<{ panel: import('../src/ui/ObjectPanel').ObjectPanel; root: FakeEl }> {
  const { ObjectPanel } = await import('../src/ui/ObjectPanel');
  const { spaceMetrics } = await import('../src/terrain/spaceMetrics');
  const { classifyScanShape } = await import('../src/terrain/scanShape');
  const pos = room();
  const shape = classifyScanShape(pos);
  const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior' });
  const panel = new ObjectPanel({ onExportReport: async () => {}, onExportFloorPlan: async () => {} });
  panel.showSpace(space, shape);
  return { panel, root: panel.element as unknown as FakeEl };
}

/** The radio input for a given snap mode (input.value === mode). */
function radioFor(root: FakeEl, mode: SnapMode): FakeEl {
  const input = root.find((e) => e.tagName === 'input' && e.type === 'radio' && e.value === mode);
  if (!input) throw new Error(`no radio for snapMode "${mode}"`);
  return input;
}

/** Select a radio: clear the group, check this one, fire its change. */
function selectRadio(root: FakeEl, mode: SnapMode): void {
  const target = radioFor(root, mode);
  for (const r of root.findAll((e) => e.tagName === 'input' && e.type === 'radio' && e.name === target.name)) {
    r.checked = r === target;
  }
  target.dispatch('change');
}

describe('ObjectPanel — floor-plan export options control', () => {
  it('defaults match FLOOR_PLAN_EXPORT_DEFAULTS (and main.ts FLOORPLAN_OPTIONS)', async () => {
    const { FLOOR_PLAN_EXPORT_DEFAULTS } = await import('../src/ui/ObjectPanel');
    expect(FLOOR_PLAN_EXPORT_DEFAULTS).toEqual({ snapMode: 'auto', adaptiveBand: true });
    const { panel } = await makeInteriorPanel();
    expect(panel.floorPlanOptions()).toEqual(FLOOR_PLAN_EXPORT_DEFAULTS);
  });

  it('renders all three wall segments + the adaptive-height toggle', async () => {
    const { root } = await makeInteriorPanel();
    for (const mode of ['auto', 'strong', 'off'] as SnapMode[]) {
      expect(root.find((e) => e.tagName === 'input' && e.type === 'radio' && e.value === mode)).toBeDefined();
    }
    expect(root.find((e) => e.tagName === 'input' && e.type === 'checkbox')).toBeDefined();
    // The default-checked segment is 'auto'.
    expect(radioFor(root, 'auto').checked).toBe(true);
    expect(radioFor(root, 'strong').checked).toBe(false);
  });

  it('"Square" segment sets snapMode = strong in floorPlanOptions()', async () => {
    const { panel, root } = await makeInteriorPanel();
    selectRadio(root, 'strong');
    expect(panel.floorPlanOptions().snapMode).toBe('strong');
  });

  it('"As-is" segment sets snapMode = off', async () => {
    const { panel, root } = await makeInteriorPanel();
    selectRadio(root, 'off');
    expect(panel.floorPlanOptions().snapMode).toBe('off');
  });

  it('toggling Adaptive height off flows into floorPlanOptions()', async () => {
    const { panel, root } = await makeInteriorPanel();
    const check = root.find((e) => e.tagName === 'input' && e.type === 'checkbox');
    if (!check) throw new Error('no adaptive-height checkbox');
    expect(check.checked).toBe(true); // default on
    check.checked = false;
    check.dispatch('change');
    expect(panel.floorPlanOptions().adaptiveBand).toBe(false);
  });

  it('floorPlanOptions() returns a copy (callers cannot mutate internal state)', async () => {
    const { panel } = await makeInteriorPanel();
    const a = panel.floorPlanOptions();
    (a as { snapMode: SnapMode }).snapMode = 'off';
    expect(panel.floorPlanOptions().snapMode).toBe('auto');
  });
});
