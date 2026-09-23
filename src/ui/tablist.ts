/**
 * tablist.ts
 *
 * A shared ARIA roving-tabindex tablist: builds the `role="tab"` buttons over
 * a caller's items, wires Arrow/Home/End keyboard navigation (wrapping at the
 * ends) and click activation, and syncs `aria-selected` / `tabindex` /
 * `is-active` on demand. DesktopWorkspace (the desktop segmented mode
 * switcher) and MobileSheet (the phone segmented tab switcher) authored this
 * exact construction/keydown/sync sequence twice, differing only in class
 * names, id prefixes and which dataset key their own selectors key off — this
 * is the one implementation both compose, the same way panelChrome.ts's
 * `wireRailToggle` is already shared between the left and right rails.
 *
 * This module owns tab-button chrome only. The tabpanel hosts, the active-id
 * state, and any host-side `is-active` toggling on those hosts stay with the
 * caller — a tablist has no opinion on what it switches between.
 */

import { el } from './dom';

export interface TablistItemDef<Id extends string> {
  readonly id: Id;
  readonly label: string;
  /** Hover text — every tab carries one, so the choice is never a guess. */
  readonly title: string;
}

export interface TablistConfig<Id extends string> {
  /** The tabs, in display order. Also the Arrow/Home/End navigation order. */
  readonly items: ReadonlyArray<TablistItemDef<Id>>;
  /** Class applied to the `role="tablist"` root. */
  readonly tablistClassName: string;
  /** The tablist's accessible name (`aria-label`). */
  readonly tablistLabel: string;
  /** Class applied to every `role="tab"` button. */
  readonly tabClassName: string;
  /** `id` for a tab button, given its item id. */
  readonly tabId: (id: Id) => string;
  /** `aria-controls` target for a tab button, given its item id. */
  readonly panelId: (id: Id) => string;
  /**
   * Stamps whatever `dataset` key a caller's own selectors and tests key off
   * (DesktopWorkspace reads `dataset.mode`, MobileSheet reads `dataset.tab`).
   */
  readonly setDataset: (tab: HTMLButtonElement, id: Id) => void;
  /** Fired on click and on Arrow/Home/End selection. */
  readonly activate: (id: Id) => void;
}

export interface Tablist<Id extends string> {
  /** The `role="tablist"` root to mount. */
  readonly element: HTMLElement;
  /** Every tab button, by item id. */
  readonly tabs: ReadonlyMap<Id, HTMLButtonElement>;
  /**
   * Reflect `active` onto every tab's `aria-selected` / roving `tabindex` /
   * `is-active`. Active state is never colour-only. Call after construction
   * and after every change to the caller's active id.
   */
  sync(active: Id): void;
}

/** Build the tablist element and wire its keyboard + click behaviour. */
export function buildTablist<Id extends string>(cfg: TablistConfig<Id>): Tablist<Id> {
  const tabs = new Map<Id, HTMLButtonElement>();
  const tablist = el('div', { className: cfg.tablistClassName });
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', cfg.tablistLabel);

  const onTabKey = (ev: KeyboardEvent, id: Id): void => {
    const idx = cfg.items.findIndex((it) => it.id === id);
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % cfg.items.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + cfg.items.length) % cfg.items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = cfg.items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const target = cfg.items[next].id;
    cfg.activate(target);
    tabs.get(target)?.focus();
  };

  for (const { id, label, title } of cfg.items) {
    const tab = el('button', { className: cfg.tabClassName, text: label, type: 'button', title });
    tab.setAttribute('role', 'tab');
    cfg.setDataset(tab, id);
    tab.id = cfg.tabId(id);
    tab.setAttribute('aria-controls', cfg.panelId(id));
    tab.addEventListener('click', () => cfg.activate(id));
    tab.addEventListener('keydown', (ev) => onTabKey(ev as KeyboardEvent, id));
    tabs.set(id, tab);
    tablist.append(tab);
  }

  return {
    element: tablist,
    tabs,
    sync(active: Id): void {
      for (const { id } of cfg.items) {
        const tab = tabs.get(id);
        if (!tab) continue;
        const isActive = id === active;
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        tab.setAttribute('tabindex', isActive ? '0' : '-1'); // roving tabindex
        tab.classList.toggle('is-active', isActive);
      }
    },
  };
}
