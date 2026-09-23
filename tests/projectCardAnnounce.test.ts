/**
 * projectCardAnnounce.test.ts
 *
 * SHELL-F3: the "Project ready" card summarised a freshly opened scan with no
 * ARIA live region at all, so a screen-reader user never learned it appeared —
 * and since the card self-dismisses in a few seconds with nothing else
 * repeating its content at that moment, the summary was lost to them entirely.
 *
 * The fix announces the summary through the app's one shared polite live
 * region (politeAnnounce.ts) rather than minting a second live region on the
 * card root, which would compete with DropZone's for a screen reader's
 * announcement queue.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl } from './support/measurePanelDom';

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

/** A fake polite live region plus a document.querySelector that resolves it. */
function withLiveRegion(): { textOf: () => string } {
  let current = '';
  const region = {
    get textContent(): string { return current; },
    set textContent(v: string) { current = v; },
  };
  const g = globalThis as unknown as { document: Record<string, unknown> };
  g.document.querySelector = (sel: string): unknown =>
    sel === '.olv-visually-hidden[role="status"]' ? region : null;
  return { textOf: () => current };
}

const INFO = {
  name: 'campus.laz',
  format: 'laz',
  shownCount: 4_200_000,
  totalCount: 4_200_000,
  width: 1, depth: 1, height: 1,
  sizeUnit: 'm' as const,
  maxPhysicalDimM: 200,
  hasRgb: false,
  hasIntensity: false,
  hasClassification: false,
};

describe('ProjectCard — live announcement', () => {
  it('announces the scan summary through the shared live region when it appears', async () => {
    const { textOf } = withLiveRegion();
    const { ProjectCard } = await import('../src/ui/ProjectCard');
    const card = new ProjectCard();

    card.show(INFO);

    const text = textOf();
    expect(text).toContain('campus.laz');
    expect(text).toContain('4.2M');
  });

  it('does not throw where the DOM stub carries no queryable document', async () => {
    // No withLiveRegion() — document.querySelector is absent, matching the
    // stub tests/projectCardLane.test.ts already builds for this module.
    const g = globalThis as unknown as { document: Record<string, unknown> };
    delete g.document.querySelector;
    const { ProjectCard } = await import('../src/ui/ProjectCard');
    const card = new ProjectCard();
    expect(() => card.show(INFO)).not.toThrow();
  });

  it('announces the new summary each time a different scan is shown', async () => {
    const { textOf } = withLiveRegion();
    const { ProjectCard } = await import('../src/ui/ProjectCard');
    const card = new ProjectCard();

    card.show(INFO);
    expect(textOf()).toContain('campus.laz');

    card.show({ ...INFO, name: 'tunnel.e57' });
    expect(textOf()).toContain('tunnel.e57');
  });
});
