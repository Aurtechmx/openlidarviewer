/**
 * classLegendLiveAnnounce.test.ts
 *
 * INSPECT-INSP-1: the Classes legend's filter banner and "classification
 * unavailable" caption used to carry role="status"/aria-live="polite" on
 * nodes toggled with the `olv-hidden` (display:none) class — the exact
 * pattern the project's own DropZone toast was rebuilt to avoid, because a
 * live-region role set on a node in the same tick it becomes visible and
 * gains its text does not announce reliably.
 *
 * The fix routes both captions' text through the app's single shared polite
 * live region (politeAnnounce.ts) instead. These tests pin that the region
 * actually receives the banner/notice text, not just that the visual caption
 * updates (which passed before the fix and proves nothing about announcement).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ClassLegendPanel } from '../src/ui/ClassLegendPanel';
import { FakeEl, installFakeDom, byClass } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.createDocumentFragment = (): FakeEl => new FakeEl('#fragment');
});

/**
 * A fake polite live region plus a document stub that resolves to it.
 * `announcePolite` clears the region (writes '') before setting the real
 * text, so `history` records only the non-empty writes — the announcements
 * a screen reader would actually hear.
 */
function withLiveRegion(): { textOf: () => string; history: string[] } {
  const history: string[] = [];
  let current = '';
  const region = {
    get textContent(): string {
      return current;
    },
    set textContent(v: string) {
      current = v;
      if (v !== '') history.push(v);
    },
  };
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.querySelector = (sel: string): unknown =>
    sel === '.olv-visually-hidden[role="status"]' ? region : null;
  return { textOf: () => region.textContent, history };
}

const COUNTS = new Map<number, number>([
  [1, 100],
  [2, 200],
  [6, 50],
]);

describe('ClassLegendPanel — live announcement', () => {
  it('announces the filter banner through the shared live region when a class is hidden', () => {
    const { textOf } = withLiveRegion();
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: 350 });

    panel.applyFilter([6]);

    expect(textOf()).toBe('Filtered — showing 2 of 3 classes');
    // The visual caption still carries the same text — this is additive,
    // not a replacement for the visible banner.
    const banner = byClass(panel.element as unknown as FakeEl, 'olv-cl-banner');
    expect(banner?.textContent).toBe('Filtered — showing 2 of 3 classes');
  });

  it('re-announces when the shown count actually changes, and does not repeat when nothing changed', () => {
    const { history } = withLiveRegion();
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: 350 });

    panel.applyFilter([6]);
    expect(history).toEqual(['Filtered — showing 2 of 3 classes']);

    // Re-rendering for an unrelated reason (palette toggle) with the filter
    // unchanged must not spam a second identical announcement.
    panel.setColorblindSafe(true);
    expect(history).toEqual(['Filtered — showing 2 of 3 classes']);

    // Hiding a second class changes the count, so it must announce again.
    panel.applyFilter([6, 2]);
    expect(history).toEqual([
      'Filtered — showing 2 of 3 classes',
      'Filtered — showing 1 of 3 classes',
    ]);
  });

  it('the banner and unavailable-note nodes are not themselves live regions (display:none defeats them)', () => {
    const panel = new ClassLegendPanel();
    panel.setClasses(COUNTS, { loaded: 350 });
    const banner = byClass(panel.element as unknown as FakeEl, 'olv-cl-banner');
    const note = byClass(panel.element as unknown as FakeEl, 'olv-cl-unavailable');
    expect(banner?.getAttribute('role')).toBeNull();
    expect(banner?.getAttribute('aria-live')).toBeNull();
    expect(note?.getAttribute('role')).toBeNull();
    expect(note?.getAttribute('aria-live')).toBeNull();
  });

  it('announces a classification-unavailable notice through the shared live region', () => {
    const { textOf, history } = withLiveRegion();
    const panel = new ClassLegendPanel();
    panel.setClasses(new Map(), { loaded: 0 });

    panel.setUnavailableNotice('No classification was changed — the file is too large.');
    expect(textOf()).toBe('No classification was changed — the file is too large.');

    // A repeated refusal announces again — a screen-reader user needs told
    // twice, matching politeAnnounce.ts's documented contract.
    panel.setUnavailableNotice('No classification was changed — the file is too large.');
    expect(history).toEqual([
      'No classification was changed — the file is too large.',
      'No classification was changed — the file is too large.',
    ]);
  });

  it('does not throw where the DOM stub has no queryable document (other unit tests)', () => {
    // No withLiveRegion() call here — `document.querySelector` is absent,
    // matching every other ClassLegendPanel unit test's stub.
    const panel = new ClassLegendPanel();
    expect(() => {
      panel.setClasses(COUNTS, { loaded: 350 });
      panel.applyFilter([6]);
      panel.setUnavailableNotice('unavailable');
    }).not.toThrow();
  });
});
