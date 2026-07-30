/**
 * The refusal message from the full-screen control has to reach the one polite
 * live region the application mounts, and the wiring that carries it there has
 * to stay wired.
 *
 * It was unwired once. `FullscreenToggle` took an optional `announce` callback,
 * `Stage` constructed it with no arguments, and the message went into a node
 * with no role and no aria-live that is hidden from sight. A screen-reader user
 * got the dead-control experience the change was written to remove, while the
 * source and a test title both said otherwise.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POLITE_REGION_SELECTOR, announcePolite } from '../src/ui/politeAnnounce';

/** Minimal stand-in: only querySelector and a writable textContent are used. */
function docWith(region: { textContent: string } | null): Document {
  return { querySelector: (s: string) => (s === POLITE_REGION_SELECTOR ? region : null) } as
    unknown as Document;
}

describe('announcePolite', () => {
  it('writes into the region the accessibility suite pins', () => {
    const region = { textContent: 'stale' };
    expect(announcePolite('fullscreen was refused', docWith(region))).toBe(true);
    expect(region.textContent).toBe('fullscreen was refused');
  });

  it('reports failure rather than throwing when no region is mounted', () => {
    expect(announcePolite('anything', docWith(null))).toBe(false);
  });

  it('clears before writing, so an identical repeat still announces', () => {
    // A screen reader announces a change. Assigning byte-identical text is not
    // one, so a second refusal would be silent without the clear.
    const seen: string[] = [];
    const region = {
      _t: '',
      get textContent() {
        return this._t;
      },
      set textContent(v: string) {
        this._t = v;
        seen.push(v);
      },
    };
    const doc = docWith(region as unknown as { textContent: string });
    announcePolite('refused', doc);
    announcePolite('refused', doc);
    expect(seen).toEqual(['', 'refused', '', 'refused']);
  });
});

describe('the host keeps the announcer wired', () => {
  const stage = readFileSync(join(__dirname, '../src/ui/Stage.ts'), 'utf8');

  it('Stage passes an announce route to FullscreenToggle', () => {
    // Matching the argument, not merely the import: `new FullscreenToggle()`
    // with no arguments is the exact regression this guards.
    expect(
      /new FullscreenToggle\(\s*\{[^}]*announce\s*:/.test(stage),
      'FullscreenToggle must be constructed with an announce route, or a refused ' +
        'request reaches no screen reader.',
    ).toBe(true);
  });

  it('does not mount a second screen-reader-only region', () => {
    // The contract is narrower than "one aria-live in the app". Stage already
    // owns a VISIBLE polite banner, and several panels own their own; those are
    // seen as well as announced, so a reader can tell them apart. What must stay
    // singular is the screen-reader-only channel, because two hidden polite
    // queues are indistinguishable to the listener. tests/e2e/a11yAnnouncements
    // asserts exactly one `.olv-visually-hidden[role="status"]`, owned by
    // DropZone, so Stage must not create one.
    const hiddenRegions = stage.match(/olv-visually-hidden/g) ?? [];
    expect(hiddenRegions).toHaveLength(0);
  });
});
