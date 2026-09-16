/**
 * projectCardLane.test.ts
 *
 * The top-centre lane holds one surface at a time.
 *
 * Opening a scan used to raise the "Project ready" card and the
 * recommended-view chip in the same breath, at overlapping offsets in the same
 * band. The chip is the smaller of the two and sat on the modal layer, so for
 * the card's whole seven seconds it covered the card that had just been asked
 * for. Both were correct on their own and the pair was unreadable.
 *
 * The fix is ownership rather than offsets: the card takes the lane, and hands
 * it on when it leaves. These cases hold that contract. The successor waits,
 * runs once after the fade that follows the card's own timer or its ×, and is
 * dropped when something else takes the lane instead.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { FakeEl } from './support/measurePanelDom';

/** Timers the test drives by hand, so the seven-second wait costs nothing. */
const pending = new Map<number, () => void>();
let nextTimer = 1;

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (tag: string) => new FakeEl(tag) };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
  g.window = {
    setTimeout: (fn: () => void) => { pending.set(nextTimer, fn); return nextTimer++; },
    clearTimeout: (id: number) => { pending.delete(id); },
  };
  g.clearTimeout = (id: number) => { pending.delete(id); };
});

/** Run the card's dismissal timer as if its full delay had passed. */
function runTimers(): void {
  const due = [...pending.values()];
  pending.clear();
  for (const fn of due) fn();
}

const INFO = {
  name: 'scan.laz',
  format: 'laz',
  shownCount: 10,
  totalCount: 10,
  width: 1, depth: 1, height: 1,
  sizeUnit: 'm' as const,
  maxPhysicalDimM: 1,
  hasRgb: false,
  hasIntensity: false,
  hasClassification: false,
};

async function makeCard() {
  const { ProjectCard } = await import('../src/ui/ProjectCard');
  const card = new ProjectCard();
  return { card, el: card.element as unknown as FakeEl };
}

describe('the project card owns the top-centre lane', () => {
  it('does not hand the lane on while it is still up', async () => {
    const { card, el } = await makeCard();
    const successor = vi.fn();
    card.show({ ...INFO, onDismiss: successor });
    expect(el.classList.contains('olv-visible')).toBe(true);
    expect(successor).not.toHaveBeenCalled();
  });

  it('hands the lane on once when its own timer expires', async () => {
    const { card, el } = await makeCard();
    const successor = vi.fn();
    card.show({ ...INFO, onDismiss: successor });
    runTimers();
    expect(el.classList.contains('olv-visible')).toBe(false);
    // The card is fading; the lane is handed on when the fade ends, here by
    // the fallback timer since this DOM reports no transition end.
    expect(successor).not.toHaveBeenCalled();
    runTimers();
    expect(successor).toHaveBeenCalledTimes(1);
    // Both timers are spent; nothing fires the successor a second time.
    runTimers();
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it('hands the lane on when the user presses ×', async () => {
    const { card, el } = await makeCard();
    const successor = vi.fn();
    card.show({ ...INFO, onDismiss: successor });
    const dismiss = el.querySelector('.olv-pc-dismiss');
    expect(dismiss, 'the card renders a dismiss control').not.toBeNull();
    dismiss!.click();
    expect(successor).not.toHaveBeenCalled();
    runTimers();
    expect(successor).toHaveBeenCalledTimes(1);
    runTimers();
    expect(successor).toHaveBeenCalledTimes(1);
  });

  it('drops the successor when something else takes the lane', async () => {
    // hide() is what arming a measurement or closing the scan calls. The lane
    // is wanted for that, not for a camera suggestion arriving on top of it.
    const { card } = await makeCard();
    const successor = vi.fn();
    card.show({ ...INFO, onDismiss: successor });
    card.hide();
    runTimers();
    expect(successor).not.toHaveBeenCalled();
  });

  it('a card shown with no successor still dismisses cleanly', async () => {
    const { card, el } = await makeCard();
    card.show(INFO);
    runTimers();
    expect(el.classList.contains('olv-visible')).toBe(false);
  });
});

describe('the stylesheet puts both surfaces in one lane', () => {
  it('every centred surface reads the lane token, and the chip left the modal layer', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (f: string): string =>
      readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8');
    expect(read('02-overlays-chrome.css')).toMatch(/--olv-lane-top:/);
    for (const [file, selector] of [
      ['45-dock-and-panels.css', '.olv-toast'],
      ['56-inspector-panels.css', '.olv-project-card'],
      ['60-measure-inspect.css', '.olv-measure-hint'],
      ['70-measurement-panels.css', '.olv-anno-hint'],
      ['70-measurement-panels.css', '.olv-measure-bar'],
      ['40-inspector.css', '.olv-rvc'],
    ] as const) {
      const css = read(file);
      const rule = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
      expect(rule, `${selector} is missing from ${file}`).not.toBeNull();
      expect(rule![1], `${selector} still hard-codes its own top`).toMatch(/top:[^;]*--olv-lane-top/);
    }
    const rvc = /\.olv-rvc\s*\{([^}]*)\}/.exec(read('40-inspector.css'))![1];
    expect(rvc).not.toMatch(/z-index:\s*var\(--z-modal\)/);
  });
});
