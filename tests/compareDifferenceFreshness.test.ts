// What these tests would catch:
//
//  - A finished difference raster still offered for download after the
//    Before/After pair was changed to another pair.
//  - A raster kept after one of its scans was closed while other scans stay open.
//  - A raster that comes back after its scan was closed and reopened.

import { describe, it, expect } from 'vitest';
import { beginCompareRun, CompareRunGuard, createCompareDifference, createComparePairPicker, type ComparePairSelection, type HeldDifference } from '../src/app/comparePair';

function scene(names: string[]) {
  const layers = new Map<string, object>(names.map((n) => [n, { n }]));
  const stable = new Map<string, string>(names.map((n) => [n, `stable-${n}`]));
  let selection: ComparePairSelection = { before: null, after: null };
  const slot: { lastDifference: HeldDifference | null } = { lastDifference: null };
  const ui = { available: false, result: ['A (before) → B (after)'] as readonly string[] };
  const diff = createCompareDifference({
    slot,
    ids: () => [...layers.keys()],
    selection: () => selection,
    lookup: (id) => layers.get(id),
    stableIdFor: (id) => stable.get(id) ?? null,
    setDifferenceAvailable: (on) => (ui.available = on),
    setCompareResult: (l) => (ui.result = l),
  });
  const compare = (b: string, a: string): void => {
    selection = { before: b, after: a };
    diff.begin([b, a], layers.get(b), layers.get(a));
    diff.hold({ stem: `${b}-to-${a}-difference`, asc: () => 'ncols 1' });
    ui.available = true;
    ui.result = [`${b} (before) → ${a} (after)`];
  };
  const downloads: string[] = [];
  const download = (): void => diff.download((f) => downloads.push(f));
  return { layers, stable, slot, ui, diff, compare, download, downloads, select: (s: ComparePairSelection) => (selection = s) };
}

describe('the cached difference raster', () => {
  it('is dropped, with its download and result text, when the pair changes', () => {
    const s = scene(['A', 'B', 'C']);
    s.compare('A', 'B');
    s.diff.dropStale();
    expect(s.slot.lastDifference).not.toBeNull();
    s.select({ before: 'B', after: 'C' });
    s.diff.dropStale();
    expect(s.slot.lastDifference).toBeNull();
    expect(s.ui.available).toBe(false);
    expect(s.ui.result).toEqual([]);
    s.download();
    expect(s.downloads).toEqual([]);
    // Restoring the pair does not bring it back.
    s.select({ before: 'A', after: 'B' });
    s.diff.dropStale();
    expect(s.slot.lastDifference).toBeNull();
  });

  it('is dropped when a participating scan is closed with three open', () => {
    const s = scene(['A', 'B', 'C']);
    s.compare('A', 'B');
    s.layers.delete('C');
    s.diff.dropStale();
    expect(s.slot.lastDifference).not.toBeNull();
    s.layers.set('C', { n: 'C' });
    s.layers.delete('A');
    s.diff.dropStale();
    expect(s.slot.lastDifference).toBeNull();
    expect(s.ui.available).toBe(false);
  });

  it('does not come back when a scan of a two-scan pair is closed and reopened', () => {
    const s = scene(['A', 'B']);
    s.compare('A', 'B');
    s.layers.delete('B');
    s.diff.dropStale();
    s.layers.set('B', { n: 'B again' });
    s.diff.dropStale();
    expect(s.slot.lastDifference).toBeNull();
    s.download();
    expect(s.downloads).toEqual([]);
  });

  it('is dropped when a scan is replaced in the same slot', () => {
    const s = scene(['A', 'B']);
    s.compare('A', 'B');
    s.layers.set('B', { n: 'other' });
    s.diff.dropStale();
    expect(s.slot.lastDifference).toBeNull();
  });

  it('downloads the held pair while it is current', () => {
    const s = scene(['A', 'B']);
    s.compare('A', 'B');
    s.download();
    expect(s.downloads).toEqual(['A-to-B-difference.asc']);
  });
});

/** Just enough of a DOM for the picker: elements, children, values and change events. */
class El {
  className = '';
  textContent = '';
  value = '';
  style: Record<string, string> = {};
  children: El[] = [];
  private ls: (() => void)[] = [];
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  append(...c: El[]): void { this.children.push(...c); }
  replaceChildren(...c: El[]): void { this.children = c; }
  addEventListener(_t: string, cb: () => void): void { this.ls.push(cb); }
  change(v: string): void { this.value = v; this.ls.forEach((cb) => cb()); }
  find(cls: string): El | undefined {
    for (const c of this.children) { if (c.className === cls) return c; const f = c.find(cls); if (f) return f; }
    return undefined;
  }
}

describe('a comparison still running when the pair changes', () => {
  it('is retired, so it never publishes a result for the old pair', () => {
    const layers = new Map<string, object>([['A', {}], ['B', {}], ['C', {}]]);
    const guard = new CompareRunGuard<unknown>();
    let selection: ComparePairSelection = { before: 'A', after: 'B' };
    const ui = { available: false, result: [] as readonly string[] };
    const diff = createCompareDifference({
      slot: { lastDifference: null },
      ids: () => [...layers.keys()],
      selection: () => selection,
      lookup: (id) => layers.get(id),
      stableIdFor: (id) => id,
      setDifferenceAvailable: (on) => (ui.available = on),
      setCompareResult: (l) => (ui.result = l),
      retireRun: () => guard.invalidate(),
    });
    const run = beginCompareRun(guard, [...layers.keys()], selection, (id) => layers.get(id));
    if (!run.ok) throw new Error('pair refused');
    diff.begin([run.beforeId, run.afterId], layers.get('A'), layers.get('B'));
    expect(run.current()).toBe(true);
    selection = { before: 'A', after: 'C' };
    diff.dropStale();
    expect(run.current()).toBe(false);
  });
});

describe('a shown comparison with no raster', () => {
  it('has its result text cleared when the pair changes', () => {
    const s = scene(['A', 'B', 'C']);
    s.select({ before: 'A', after: 'B' });
    s.diff.begin(['A', 'B'], s.layers.get('A'), s.layers.get('B'));
    s.ui.result = ['A (before) → B (after)', 'Not comparable'];
    s.select({ before: 'A', after: 'C' });
    s.diff.dropStale();
    expect(s.ui.result).toEqual([]);
  });
});

describe('the Before/After picker', () => {
  it('reports a user change of either selection', () => {
    const doc = { createElement: (t: string) => new El(t) } as unknown as Document;
    const p = createComparePairPicker(doc);
    p.setChoices([{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }, { id: 'C', name: 'c' }]);
    let calls = 0;
    p.onChange(() => calls++);
    (p.element as unknown as El).find('olv-compare-after')!.change('C');
    expect(calls).toBe(1);
    expect(p.selection()).toEqual({ before: 'A', after: 'C' });
  });
});
