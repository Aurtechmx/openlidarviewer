/**
 * panelChrome.ts — the overlay column's own layout chrome.
 *
 * These helpers own the geometry of the side panel columns: keeping a column
 * clear of the measure toolbar and the dock, the one-tap rail collapse, and
 * wheel ownership over a scrolling panel. None of them touch the Viewer, the
 * scan, or any application state — they read element boxes and write CSS
 * custom properties — so they belong beside the panels rather than in main.ts.
 */
import { el } from './dom';

/**
 * Keep the left panel column clear of the measure toolbar (v0.4.5 overlap
 * fix). The toolbar (`.olv-measure-bar`) is centred at the same `top: 56px`
 * band the `.olv-left-panels` column anchors to, and activating Measure
 * auto-opens the Measurements panel into that column — so the panel used to
 * paint over the toolbar's left half, hiding the first kind pills. The
 * toolbar's height is dynamic (kind pills wrap at narrow widths, the
 * Finish-polygon button comes and goes, hint text reflows), so a static CSS
 * offset can't be right at every width. Instead a ResizeObserver mirrors
 * the toolbar's REAL height into the `--olv-measure-bar-clear` custom property
 * the column's `top` is computed from; `olv-hidden` is `display: none`, so
 * the observer fires with a zero box when the toolbar hides and the column
 * snaps back up. No-ops (keeping the static layout) where ResizeObserver
 * is unavailable.
 */
export function wireMeasureBarClearance(bar: HTMLElement, column: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  try {
    const ro = new ResizeObserver(() => {
      const h = bar.offsetHeight; // 0 while .olv-hidden (display: none)
      // 8px = the column's own --space-md gap, so toolbar → first panel
      // reads with the same rhythm as panel → panel.
      column.style.setProperty('--olv-measure-bar-clear', h > 0 ? `${h + 8}px` : '0px');
    });
    ro.observe(bar);
  } catch {
    /* Static layout fallback — only ancient engines, overlap is cosmetic. */
  }
}

/**
 * P11 — the dock (bottom tool bar) is a separate fixed element; the left column
 * must never scroll its last control under it. Mirrors wireMeasureBarClearance:
 * writes the dock's REAL height into `--olv-dock-clear` (= dock height + its 14px
 * bottom offset + an 8px gap) so the column's max-height always ends above the
 * dock. Fallback 80px (the previous static reserve) keeps layout unchanged where
 * ResizeObserver is unavailable.
 */
export function wireDockClearance(dock: HTMLElement, column: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  try {
    const ro = new ResizeObserver(() => {
      const h = dock.offsetHeight; // 0 while hidden (display: none)
      column.style.setProperty('--olv-dock-clear', h > 0 ? `${h + 14 + 8}px` : '80px');
    });
    ro.observe(dock);
  } catch {
    /* Static 80px fallback — only ancient engines. */
  }
}

/**
 * P11 — collapse / expand the whole left rail with one control. The column slides
 * off-screen (transform only) leaving a slim frosted grabber tab to reopen it;
 * state persists in localStorage. Desktop/tablet only — the mobile bottom-sheet
 * owns small screens and the tab is hidden there by CSS.
 */
/**
 * Rail collapse — one grabber that slides a side panel column out of the way,
 * shared by the left rail (the single `.olv-left-panels` container) and the
 * right column (the Inspector plus the streaming/COPC card). Every element in
 * `panels` receives `collapsedClass` on toggle and is measured for centring and
 * the empty-state hide. The grabber only appears when the column holds visible
 * content, is centred on the union of the visible panels, and persists its
 * state in localStorage. Desktop only — on phones the panels live in the bottom
 * sheet and CSS hides the grabber.
 */
export interface RailToggleConfig {
  overlay: HTMLElement;
  panels: HTMLElement[];
  tabClass: string;
  chevron: string;
  collapsedClass: string;
  storageKey: string;
  ariaControls: string;
}
export function wireRailToggle(cfg: RailToggleConfig): void {
  const tab = el('button', { className: cfg.tabClass, unsafeHtml: cfg.chevron });
  tab.setAttribute('type', 'button');
  tab.setAttribute('aria-controls', cfg.ariaControls);

  const apply = (collapsed: boolean): void => {
    for (const p of cfg.panels) p.classList.toggle(cfg.collapsedClass, collapsed);
    // The tab carries its own collapsed state so it can snap to the screen edge
    // independently — several tabs can share one edge (right column: one per
    // panel) without a sibling selector confusing them.
    tab.classList.toggle('is-collapsed', collapsed);
    tab.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Show panel' : 'Hide panel';
    tab.setAttribute('aria-label', label);
    tab.title = label;
  };

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(cfg.storageKey) === '1';
  } catch {
    /* private mode — default expanded */
  }
  apply(collapsed);

  tab.addEventListener('click', () => {
    collapsed = !collapsed;
    apply(collapsed);
    try {
      localStorage.setItem(cfg.storageKey, collapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  });
  cfg.overlay.append(tab);

  // The grabber only makes sense when the column holds visible panels, and it
  // must sit AGAINST them. Centre it on the union of the visible panels' boxes
  // and hide it while the column is empty — the "Open a scan" state, where the
  // panels are display:none / carry `olv-hidden`. The collapse is transform-
  // only, so the vertical span is unchanged and the centre holds even collapsed.
  // A ResizeObserver keeps it in step; CSS `translateY(-50%)` centres on `top`.
  tab.classList.add('olv-hidden');
  const positionTab = (): void => {
    const boxes = cfg.panels
      .filter((n) => n.offsetHeight > 0 && !n.classList.contains('olv-hidden'))
      .map((n) => n.getBoundingClientRect());
    const empty = boxes.length === 0;
    tab.classList.toggle('olv-hidden', empty);
    if (empty) return;
    const top = Math.min(...boxes.map((b) => b.top));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    tab.style.top = `${Math.round((top + bottom) / 2)}px`;
  };
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver(positionTab);
      for (const p of cfg.panels) ro.observe(p);
    } catch {
      /* static fallback — the window listener + initial call still run */
    }
  }
  window.addEventListener('resize', positionTab);
  positionTab();
}

// Inline, literally-embedded chevron SVGs — the sanctioned `unsafeHtml` use (see
// dom.ts). Each points the way its rail moves to collapse; CSS flips it on state.
export const RAIL_CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15 6l-6 6 6 6"/></svg>';
export const RAIL_CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 6l6 6-6 6"/></svg>';

/**
 * P9 — contain a scrollable overlay panel's wheel events so a wheel over the
 * panel scrolls only the panel and never bubbles to a handler that could move
 * the camera or scroll the page. Passive: this is normal scrolling, so it never
 * calls `preventDefault` (which would break natural / momentum scrolling).
 */
export function containPanelWheel(panel: HTMLElement): void {
  panel.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
}

