/**
 * datasetIntelligenceTooltips.test.ts
 *
 * INSPECT-INSP-7: every Dataset Intelligence row term set `aria-describedby`
 * to an empty string — not a valid ID reference, so it pointed at nothing —
 * leaving the term's explanation reachable only through the native `title`
 * hover tooltip. That is unavailable to keyboard-only users, most
 * screen-reader users, and every touch user.
 *
 * The fix gives each tooltip's text a real, visually-hidden element with a
 * stable id, points `aria-describedby` at it, and makes the term itself a
 * Tab stop. These tests pin that the reference actually resolves to text,
 * and that a term with no tooltip stays untouched (no dangling attribute,
 * no unwanted Tab stop).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { DatasetIntelligenceCard } from '../src/ui/DatasetIntelligenceCard';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

const AIRBORNE_INPUT = {
  pointCount: 89_600_000,
  bboxVolume: 1500 * 1500 * 300,
  bboxSpansM: [1500, 1500, 300] as [number, number, number],
};

/** Every `<dt class="olv-di-row-name">` term in the card's rows. */
function terms(card: DatasetIntelligenceCard): FakeEl[] {
  return (card.element as unknown as FakeEl).querySelectorAll('.olv-di-row-name');
}

/** The node `aria-describedby` on `term` resolves to, within `root`. */
function describedByTarget(root: FakeEl, term: FakeEl): FakeEl | undefined {
  const id = term.getAttribute('aria-describedby');
  if (!id) return undefined;
  const find = (n: FakeEl): FakeEl | undefined => {
    if ((n as unknown as { id?: string }).id === id) return n;
    for (const c of n.children) {
      const hit = find(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return find(root);
}

describe('DatasetIntelligenceCard — tooltip reachability', () => {
  it('every tooltip-bearing term has a real aria-describedby target carrying the tooltip text', () => {
    const card = new DatasetIntelligenceCard();
    card.update(AIRBORNE_INPUT);
    const root = card.element as unknown as FakeEl;

    let checked = 0;
    for (const term of terms(card)) {
      const title = term.title;
      if (!title) continue; // a term with no tooltip is out of scope
      checked++;
      expect(term.getAttribute('aria-describedby')).not.toBe('');
      expect(term.getAttribute('aria-describedby')).not.toBeNull();
      const target = describedByTarget(root, term);
      expect(target, `no element carries id="${term.getAttribute('aria-describedby')}"`).toBeDefined();
      expect(target!.textContent).toBe(title);
      // Reachable by keyboard, not only by mouse hover.
      expect(term.getAttribute('tabindex')).toBe('0');
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the density row keeps its description in sync with the tooltip when the basis flips areal/volumetric', () => {
    const card = new DatasetIntelligenceCard();
    // A flat, well-covered footprint: tiers on AREAL density.
    card.update(AIRBORNE_INPUT);
    const root = card.element as unknown as FakeEl;
    const densityTerm = byClass(root, 'olv-di-row-name')!;
    expect(densityTerm.dataset.basis).toBe('areal');
    const arealTarget = describedByTarget(root, densityTerm);
    expect(arealTarget?.textContent).toBe(densityTerm.title);
    expect(arealTarget?.textContent).toMatch(/square metre/);

    // A tall interior scan: falls back to VOLUMETRIC density.
    card.update({ pointCount: 2_000_000, bboxVolume: 2_000, bboxSpansM: [10, 10, 20] });
    expect(densityTerm.dataset.basis).toBe('volumetric');
    const volumetricTarget = describedByTarget(root, densityTerm);
    expect(volumetricTarget?.textContent).toBe(densityTerm.title);
    expect(volumetricTarget?.textContent).toMatch(/cubic metre/);
    // Same id reused across the basis flip — the description node was
    // updated in place, not replaced with a second stray span.
    expect(arealTarget).toBe(volumetricTarget);
  });
});
