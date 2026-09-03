/**
 * classLegendEditRefresh.test.ts
 *
 * After an in-place class edit the Classes panel has to describe the buffer
 * that now exists.
 *
 * A live report ("classification seems off, when trying to reclassify its not
 * letting me") came from a barely-classified airborne tile that OLV opened
 * coloured by HEIGHT, because too few points carried a producer class for the
 * class ramp to read. On that scan the legend counts are the only place a class
 * edit shows: the scene does not repaint, and the toast is transient. The edit
 * landed and every number the user was looking at stayed exactly where it was,
 * which is indistinguishable from a tool that refuses.
 *
 * Two properties are pinned:
 *   1. `replaceCounts` moves the numbers (the refresh itself), and
 *   2. it does NOT reset the user's class filter, which `setClasses` does:
 *      the user's own edit is no reason to un-hide classes they hid.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';
import { noteClassificationEdited } from '../src/app/classLegendRefresh';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.createDocumentFragment = (): FakeEl => new FakeEl('#fragment');
});

/** The reported tile's split, scaled down: mostly unclassified, a little ground. */
const BEFORE = new Map<number, number>([
  [1, 18_034],
  [2, 830],
  [7, 23],
  [18, 1],
]);

/** Every row's text, so a count can be located without pinning the wording. */
function rowText(panel: ClassLegendPanel): string {
  const list = byClass(panel.element as unknown as FakeEl, 'olv-cl-list');
  const walk = (n: FakeEl): string =>
    [n.textContent ?? '', ...n.children.map(walk)].join(' ');
  return list ? walk(list) : '';
}

describe('Classes legend after an in-place class edit', () => {
  it('shows the post-edit counts, not the counts the scan opened with', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(BEFORE, { loaded: 18_888, declared: 373_332 });
    expect(rowText(panel)).toContain('830');

    // 400 unclassified points were lassoed into Ground.
    const after = new Map<number, number>([
      [1, 17_634],
      [2, 1_230],
      [7, 23],
      [18, 1],
    ]);
    panel.replaceCounts(after);
    const text = rowText(panel);
    expect(text).toContain('1,230');
    expect(text).not.toContain('18,034');
  });

  it('keeps the class filter the user set before editing', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(BEFORE, { loaded: 18_888, declared: 373_332 });
    panel.applyFilter([7, 18]); // the user hid both noise classes
    expect(panel.getVisibility().hiddenCodes()).toEqual([7, 18]);

    panel.replaceCounts(new Map(BEFORE));
    // `setClasses` would have handed back a fresh all-visible state here.
    expect(panel.getVisibility().hiddenCodes()).toEqual([7, 18]);
  });

  it('is what the class-edit notifier drives, from the edited buffer', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(BEFORE, { loaded: 4, declared: 40 });
    let cleared = 0;
    let stale = '';
    // Four points, two of which the user just moved to Ground.
    noteClassificationEdited({
      classification: Uint8Array.from([1, 2, 2, 7]),
      legend: panel,
      clearTerrainCache: () => void cleared++,
      noteStale: (m: string) => void (stale = m),
    });
    expect(cleared).toBe(1);
    expect(stale).toMatch(/re-run analyse/i);
    const text = rowText(panel);
    expect(text).toContain('2'); // the Ground row now holds two points
    expect(text).not.toContain('18,034');
  });
});
