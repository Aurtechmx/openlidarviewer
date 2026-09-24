/**
 * tablist.test.ts
 *
 * The shared ARIA roving-tabindex tablist (src/ui/tablist.ts), extracted from
 * DesktopWorkspace and MobileSheet, which had authored the identical
 * construction/keydown/sync pattern twice (SHELL-F4). Runs through the same
 * recording DOM stub the two host tests use, asserting on the same contract
 * DesktopWorkspace's and MobileSheet's own tests already pin: aria-controls
 * wiring, roving tabindex, Arrow/Home/End navigation with wraparound, and a
 * caller-supplied dataset stamp (since the two hosts key their tab lookups off
 * different dataset properties — `dataset.mode` vs `dataset.tab`).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(installLiveFakeDom);

type Id = 'a' | 'b' | 'c';

function make(activate: (id: Id) => void) {
  // Deferred import so the module-not-found case (before tablist.ts exists)
  // surfaces as a normal test failure rather than a collection-time crash.
  return import('../src/ui/tablist').then(({ buildTablist }) =>
    buildTablist<Id>({
      items: [
        { id: 'a', label: 'A', title: 'Tab A' },
        { id: 'b', label: 'B', title: 'Tab B' },
        { id: 'c', label: 'C', title: 'Tab C' },
      ],
      tablistClassName: 'olv-test-tabs',
      tablistLabel: 'Test group',
      tabClassName: 'olv-test-tab',
      tabId: (id) => `olv-test-tab-${id}`,
      panelId: (id) => `olv-test-panel-${id}`,
      setDataset: (tab, id) => { tab.dataset.kind = id; },
      activate,
    }),
  );
}

describe('buildTablist', () => {
  it('renders a role=tablist over role=tab buttons wired by aria-controls, id and the caller dataset key', async () => {
    const tl = await make(() => {});
    const root = tl.element as unknown as FakeEl;
    expect(root.attrs['role']).toBe('tablist');
    expect(root.attrs['aria-label']).toBe('Test group');
    expect(root.hasClass('olv-test-tabs')).toBe(true);
    const tabs = root.findAll((e) => e.attrs['role'] === 'tab');
    expect(tabs.map((t) => t.dataset.kind)).toEqual(['a', 'b', 'c']);
    for (const t of tabs) {
      expect(t.hasClass('olv-test-tab')).toBe(true);
      expect(t.id).toBe(`olv-test-tab-${t.dataset.kind}`);
      expect(t.attrs['aria-controls']).toBe(`olv-test-panel-${t.dataset.kind}`);
    }
    expect(tl.tabs.get('a')).toBe(tabs[0]);
    expect(tl.tabs.get('c')).toBe(tabs[2]);
  });

  it('sync() reflects the active id as aria-selected/tabindex/is-active, non-colour-only', async () => {
    const tl = await make(() => {});
    tl.sync('b');
    const b = tl.tabs.get('b') as unknown as FakeEl;
    const a = tl.tabs.get('a') as unknown as FakeEl;
    expect(b.attrs['aria-selected']).toBe('true');
    expect(b.attrs['tabindex']).toBe('0');
    expect(b.hasClass('is-active')).toBe(true);
    expect(a.attrs['aria-selected']).toBe('false');
    expect(a.attrs['tabindex']).toBe('-1');
    expect(a.hasClass('is-active')).toBe(false);
  });

  it('clicking a tab calls activate with its id', async () => {
    const seen: Id[] = [];
    const tl = await make((id) => seen.push(id));
    (tl.tabs.get('c') as unknown as FakeEl).fire('click');
    expect(seen).toEqual(['c']);
  });

  /** Fire `key` on tab `from` and assert the activation order seen so far,
   * plus (when given) which tab took focus — the shape shared by the
   * forward (Right/Down) and backward (Left/Up) roving-focus tests below. */
  function pressAndExpect(
    tl: Awaited<ReturnType<typeof make>>,
    seen: Id[],
    from: Id,
    key: string,
    expectSeen: Id[],
    focused?: Id,
  ): void {
    (tl.tabs.get(from) as unknown as FakeEl).fire('keydown', { key, preventDefault: () => {} });
    expect(seen).toEqual(expectSeen);
    if (focused) expect((tl.tabs.get(focused) as unknown as FakeEl).focused).toBe(true);
  }

  it('ArrowRight/ArrowDown activates and focuses the next tab, wrapping past the last', async () => {
    const seen: Id[] = [];
    const tl = await make((id) => seen.push(id));
    pressAndExpect(tl, seen, 'a', 'ArrowRight', ['b'], 'b');
    pressAndExpect(tl, seen, 'c', 'ArrowDown', ['b', 'a']); // wraps from the last tab back to the first
  });

  it('ArrowLeft/ArrowUp activates and focuses the previous tab, wrapping before the first', async () => {
    const seen: Id[] = [];
    const tl = await make((id) => seen.push(id));
    pressAndExpect(tl, seen, 'a', 'ArrowLeft', ['c']); // wraps from the first tab to the last
    pressAndExpect(tl, seen, 'b', 'ArrowUp', ['c', 'a']);
  });

  it('Home and End jump to the first and last tab', async () => {
    const seen: Id[] = [];
    const tl = await make((id) => seen.push(id));
    (tl.tabs.get('b') as unknown as FakeEl).fire('keydown', { key: 'End', preventDefault: () => {} });
    expect(seen).toEqual(['c']);
    (tl.tabs.get('b') as unknown as FakeEl).fire('keydown', { key: 'Home', preventDefault: () => {} });
    expect(seen).toEqual(['c', 'a']);
  });

  it('an unhandled key neither activates nor calls preventDefault', async () => {
    const seen: Id[] = [];
    let prevented = false;
    const tl = await make((id) => seen.push(id));
    (tl.tabs.get('a') as unknown as FakeEl).fire('keydown', { key: 'Tab', preventDefault: () => { prevented = true; } });
    expect(seen).toEqual([]);
    expect(prevented).toBe(false);
  });
});
