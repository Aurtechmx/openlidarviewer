/**
 * MobileSheet.ts
 *
 * The phone bottom-sheet (design audit 1.3 follow-up). Below the mobile
 * breakpoint the floating desktop panels do not fit side-by-side, so a single
 * bottom sheet hosts them all behind a three-way segmented control:
 *
 *   View    — appearance: Color by, Point size, Rendering, Visuals (the Inspector)
 *   Analyse — the terrain verdict / products and the Space / Object report
 *   Layers  — class legend, measurements, annotations, and export
 *
 * This component owns ONLY the sheet chrome — the segmented tablist, the three
 * tabpanel slots, the collapse handle, and the show/hide state. It does NOT own
 * the panels: the host (main.ts) re-parents the existing panel elements into
 * {@link slot} on mobile and restores them on desktop, so every panel keeps its
 * own logic, state and listeners. Re-parenting a live node preserves its event
 * listeners, so nothing is re-wired on a breakpoint change.
 *
 * Tab semantics use the ARIA tabs pattern (tablist / tab / tabpanel) so the
 * control is operable and announced correctly. Arrow keys move between tabs.
 *
 * Pure DOM via {@link el}; no three.js, no app singletons — unit-testable with
 * the recording-stub document the other UI tests use.
 */

import { el } from './dom';

/** The three mobile tabs, in display order. */
export type MobileTab = 'view' | 'analyse' | 'layers';

const TABS: ReadonlyArray<{ id: MobileTab; label: string }> = [
  { id: 'view', label: 'View' },
  { id: 'analyse', label: 'Analyse' },
  { id: 'layers', label: 'Layers' },
];

export interface MobileSheetOptions {
  /** Fired after the active tab changes (user click or keyboard). */
  readonly onTabChange?: (tab: MobileTab) => void;
  /** Fired after the sheet expands or collapses. */
  readonly onExpandedChange?: (expanded: boolean) => void;
  /**
   * The tab shown first. Defaults to `'analyse'` so the honesty-first verdict
   * stays the hero on phones, matching the desktop verdict-as-hero treatment.
   */
  readonly initialTab?: MobileTab;
  /**
   * Whether the sheet starts expanded. Defaults to `false` so on phones the
   * sheet opens COLLAPSED to just its head, leaving the canvas visible.
   */
  readonly initialExpanded?: boolean;
}

export class MobileSheet {
  /** The sheet root — the host appends this to the overlay. */
  readonly element: HTMLElement;

  private readonly _slots = new Map<MobileTab, HTMLElement>();
  private readonly _tabs = new Map<MobileTab, HTMLButtonElement>();
  private readonly _onTabChange?: (tab: MobileTab) => void;
  private readonly _onExpandedChange?: (expanded: boolean) => void;
  private _active: MobileTab;
  private _expanded: boolean;

  constructor(opts: MobileSheetOptions = {}) {
    this._onTabChange = opts.onTabChange;
    this._onExpandedChange = opts.onExpandedChange;
    this._active = opts.initialTab ?? 'analyse';
    // Default COLLAPSED on phones so the sheet opens as just its head.
    this._expanded = opts.initialExpanded ?? false;

    // ── tablist (the segmented control) ────────────────────────────────────
    const tablist = el('div', { className: 'olv-msheet-tabs' });
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Panel group');
    for (const { id, label } of TABS) {
      const tab = el('button', { className: 'olv-msheet-tab', text: label, type: 'button' });
      tab.setAttribute('role', 'tab');
      tab.dataset.tab = id;
      tab.id = `olv-msheet-tab-${id}`;
      tab.setAttribute('aria-controls', `olv-msheet-panel-${id}`);
      tab.addEventListener('click', () => this.setActive(id));
      tab.addEventListener('keydown', (ev) => this._onTabKey(ev as KeyboardEvent, id));
      this._tabs.set(id, tab);
      tablist.append(tab);
    }

    // ── collapse handle ────────────────────────────────────────────────────
    const handle = el('button', {
      className: 'olv-msheet-handle',
      type: 'button',
      ariaLabel: 'Collapse panel',
    });
    handle.setAttribute('aria-expanded', 'true');
    handle.addEventListener('click', () => this.toggleExpanded());
    this._handle = handle;

    const head = el('div', { className: 'olv-msheet-head' }, [tablist, handle]);
    // The whole head/grip is tappable to toggle the sheet — EXCEPT taps on a
    // tab (which select a tab) and taps on the handle (which has its own
    // listener above, so we skip here to avoid a double-toggle).
    head.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (target?.closest('[role="tab"]')) return;
      if (target?.closest('.olv-msheet-handle')) return;
      this.toggleExpanded();
    });

    // ── tabpanel slots ─────────────────────────────────────────────────────
    const body = el('div', { className: 'olv-msheet-body' });
    for (const { id } of TABS) {
      const panel = el('div', { className: 'olv-msheet-slot' });
      panel.setAttribute('role', 'tabpanel');
      panel.id = `olv-msheet-panel-${id}`;
      panel.dataset.tab = id;
      panel.setAttribute('aria-labelledby', `olv-msheet-tab-${id}`);
      this._slots.set(id, panel);
      body.append(panel);
    }
    this._body = body;

    this.element = el('div', { className: 'olv-mobile-sheet' }, [head, body]);
    this.element.setAttribute('aria-label', 'Panels');

    this._syncTabs();
    this._syncExpanded();
  }

  private _handle!: HTMLButtonElement;
  private _body!: HTMLElement;

  /** The tabpanel container the host re-parents this tab's panels into. */
  slot(tab: MobileTab): HTMLElement {
    const s = this._slots.get(tab);
    if (!s) throw new Error(`MobileSheet: unknown tab "${tab}"`);
    return s;
  }

  /** The currently selected tab. */
  getActive(): MobileTab {
    return this._active;
  }

  /** Select a tab (idempotent). Expands the sheet if it was collapsed. */
  setActive(tab: MobileTab): void {
    if (!this._slots.has(tab)) return;
    const changed = tab !== this._active;
    this._active = tab;
    if (!this._expanded) this.setExpanded(true);
    this._syncTabs();
    if (changed) this._onTabChange?.(tab);
  }

  /** Whether the body is expanded (true) or collapsed to just the head (false). */
  isExpanded(): boolean {
    return this._expanded;
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this._expanded) return;
    this._expanded = expanded;
    this._syncExpanded();
    this._onExpandedChange?.(expanded);
  }

  toggleExpanded(): void {
    this.setExpanded(!this._expanded);
  }

  /** Show or hide the whole sheet (the host hides it with no scan loaded). */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private _onTabKey(ev: KeyboardEvent, id: MobileTab): void {
    const idx = TABS.findIndex((t) => t.id === id);
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % TABS.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + TABS.length) % TABS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const target = TABS[next].id;
    this.setActive(target);
    this._tabs.get(target)?.focus();
  }

  private _syncTabs(): void {
    for (const { id } of TABS) {
      const isActive = id === this._active;
      const tab = this._tabs.get(id);
      if (tab) {
        tab.classList.toggle('is-active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
        // Roving tabindex: only the active tab is in the tab order.
        tab.setAttribute('tabindex', isActive ? '0' : '-1');
      }
      const slot = this._slots.get(id);
      if (slot) slot.classList.toggle('is-active', isActive);
    }
  }

  private _syncExpanded(): void {
    this.element.classList.toggle('is-collapsed', !this._expanded);
    this._body.classList.toggle('olv-hidden', !this._expanded);
    this._handle.setAttribute('aria-expanded', this._expanded ? 'true' : 'false');
    this._handle.setAttribute('aria-label', this._expanded ? 'Collapse panel' : 'Expand panel');
  }
}
