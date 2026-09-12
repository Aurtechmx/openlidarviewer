/**
 * reclassifyRevealsTarget.test.ts
 *
 * A lasso reclassify only edits points the user can currently see — the guard
 * that stops it rewriting points hidden behind a filter. Reclassifying INTO a
 * class the filter hides therefore landed the edit and hid its own result in
 * the same frame: the points vanished and the tool read as inert.
 *
 * Driven through the REAL `ClassLegendPanel`. A first version of this test used
 * a fake legend whose `setClasses` merely recorded counts, and it passed while
 * the code under it reset the user's filter, cleared the derived-provenance
 * caption and emitted no change event — so the panel would have said a class
 * was visible while the GPU mask still hid it. A stub that models less than the
 * real surface proves less than it appears to.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import { afterClassEdit, noteClassificationEdited } from '../src/app/classLegendRefresh';
import { reclassifyOutcome } from '../src/ui/reclassifyOutcome';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.createDocumentFragment = (): FakeEl => new FakeEl('#fragment');
});

const COUNTS = new Map<number, number>([[1, 1_781_973], [2, 153_215], [6, 21_057], [7, 4_477]]);

/** The panel as the user left it: a derived classification with 6 and 7 hidden. */
function panelWithFilter(): { panel: ClassLegendPanel; hiddenSeen: number[][] } {
  const panel = new ClassLegendPanel();
  panel.setClasses(COUNTS, { loaded: 1_960_722, declared: 39_143_991 });
  panel.setDerivedProvenance(true, { confidencePct: 71, warnings: [] });
  panel.applyFilter([6, 7]);
  const hiddenSeen: number[][] = [];
  panel.onChange((v) => hiddenSeen.push(v.hiddenCodes()));
  return { panel, hiddenSeen };
}

describe('revealing the class a lasso reclassify wrote into', () => {
  it('shows the target and leaves every other hidden class hidden', () => {
    const { panel } = panelWithFilter();
    expect(afterClassEdit(panel, 6)).toBe(true);
    expect(panel.getVisibility().hiddenCodes(), 'the reveal opened the wrong filter').toEqual([7]);
  });

  it('tells the renderer, so the mask cannot disagree with the panel', () => {
    // `setClasses` emits nothing, which is why it must not be used here: the
    // legend would read "6 visible" while the GPU still hid it.
    const { panel, hiddenSeen } = panelWithFilter();
    afterClassEdit(panel, 6);
    expect(hiddenSeen, 'no change event reached the host').toEqual([[7]]);
  });

  it('keeps the derived-provenance flag the capability model reads', () => {
    const { panel } = panelWithFilter();
    afterClassEdit(panel, 6);
    expect(panel.classificationIsDerived(), 'a derived classification read as authoritative').toBe(true);
  });

  it('reports no reveal when the target was already visible', () => {
    const { panel, hiddenSeen } = panelWithFilter();
    expect(afterClassEdit(panel, 2)).toBe(false);
    expect(hiddenSeen).toEqual([]);
  });

  it('leaves the counts to the notifier that already recounts', () => {
    // reclassifyLasso fires onClassificationEdited before it returns, and that
    // path recounts through replaceCounts, which keeps the filter. Recounting
    // again in the reveal would undo it.
    const { panel } = panelWithFilter();
    noteClassificationEdited({
      classification: Uint8Array.from([1, 6, 6, 2]),
      legend: panel,
      clearTerrainCache: () => {},
      noteStale: () => {},
    });
    afterClassEdit(panel, 6);
    expect(panel.getVisibility().hiddenCodes()).toEqual([7]);
    expect(panel.classificationIsDerived()).toBe(true);
  });
});

describe('the toast says the filter was opened', () => {
  it('names the revealed class after a successful edit', () => {
    const msg = reclassifyOutcome({ changedCount: 4, pointCount: 6 }, 6, true);
    expect(msg).toContain('Reclassified 4 points → class 6.');
    expect(msg).toMatch(/hidden by the class filter/);
  });

  it('stays quiet about the filter when nothing was revealed', () => {
    expect(reclassifyOutcome({ changedCount: 4, pointCount: 6 }, 6, false)).toBe('Reclassified 4 points → class 6.');
  });
});
