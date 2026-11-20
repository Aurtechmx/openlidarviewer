/**
 * projectCardRemeasure.test.ts
 *
 * The "Project ready" card states the scan's size. A phone scan opens with no
 * CRS, so the Size row reads in source units. When the user picks a metre CRS
 * while the card is still up, the row must restate the size in metres (and
 * gain the Suggested row that only a physical size allows), and go back to
 * source units after "Use detected". The card is not announced again and its
 * timer keeps running: only the size rows change.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { FakeEl } from './support/measurePanelDom';
import { installManualTimerDom } from './helpers/manualTimerDom';

let runTimers: () => void;

beforeAll(() => {
  ({ runTimers } = installManualTimerDom());
});

const SOURCE = { width: 0.6, depth: 0.4, height: 0.5, sizeUnit: 'source units' as const, maxPhysicalDimM: null };
const METRES = { width: 0.6, depth: 0.4, height: 0.5, sizeUnit: 'm' as const, maxPhysicalDimM: 0.6 };

const INFO = {
  name: 'phone-scan.glb',
  format: 'glb',
  shownCount: 10,
  totalCount: 10,
  ...SOURCE,
  hasRgb: true,
  hasIntensity: false,
  hasClassification: false,
};

/** The value cell of the row labelled `label`, or null when the row is absent. */
function rowValue(root: FakeEl, label: string): string | null {
  for (const row of root.querySelectorAll('.olv-pc-row')) {
    if (row.querySelector('.olv-pc-label')?.textContent === label) {
      return row.querySelector('.olv-pc-value')?.textContent ?? null;
    }
  }
  return null;
}

async function makeCard() {
  const { ProjectCard } = await import('../src/ui/ProjectCard');
  const card = new ProjectCard();
  return { card, el: card.element as unknown as FakeEl };
}

describe('the Project card size follows a CRS change while it is up', () => {
  it('restates the size in metres, then in source units again', async () => {
    const { card, el } = await makeCard();
    const scan = {};
    let frame: typeof SOURCE | typeof METRES = SOURCE;
    card.show({ ...INFO, source: scan, remeasure: () => frame });
    expect(rowValue(el, 'Size')).toBe('0.6 × 0.4 × 0.5 source units');
    expect(rowValue(el, 'Suggested')).toBeNull();

    frame = METRES;
    card.remeasure(scan);
    expect(rowValue(el, 'Size')).toBe('0.6 × 0.4 × 0.5 m');
    expect(rowValue(el, 'Suggested')).toBe('Orbit — object scale');
    // The rest of the card is untouched.
    expect(rowValue(el, 'Format')).toBe('GLB');
    expect(rowValue(el, 'Attributes')).toBe('RGB');
    expect(el.querySelector('.olv-pc-name')?.textContent).toBe('phone-scan.glb');

    frame = SOURCE;
    card.remeasure(scan);
    expect(rowValue(el, 'Size')).toBe('0.6 × 0.4 × 0.5 source units');
    expect(rowValue(el, 'Suggested')).toBeNull();
  });

  it('leaves the card alone for a CRS change on another scan', async () => {
    const { card, el } = await makeCard();
    const scan = {};
    card.show({ ...INFO, source: scan, remeasure: () => METRES });
    card.remeasure({});
    expect(rowValue(el, 'Size')).toBe('0.6 × 0.4 × 0.5 source units');
  });

  it('does nothing once the card has gone', async () => {
    const { card, el } = await makeCard();
    const scan = {};
    let calls = 0;
    card.show({ ...INFO, source: scan, remeasure: () => { calls++; return METRES; } });
    card.hide();
    card.remeasure(scan);
    expect(calls).toBe(0);
    expect(el.classList.contains('olv-visible')).toBe(false);
  });

  it('keeps its timer: the card still leaves on schedule after a re-measure', async () => {
    const { card, el } = await makeCard();
    const scan = {};
    card.show({ ...INFO, source: scan, remeasure: () => METRES });
    card.remeasure(scan);
    expect(el.classList.contains('olv-visible')).toBe(true);
    runTimers();
    expect(el.classList.contains('olv-visible')).toBe(false);
  });
});
