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
import { applyClassicScrollbarClass } from './classicScrollbars';
import { storageGet, storageSet } from './safeStorage';

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
 *
 * The push-down only applies when the centred toolbar actually overlaps the
 * column horizontally. On a wide viewport the toolbar clears the far-left
 * column entirely, so pushing the panels down just opens dead space above
 * them; there the column stays at the shared 56px band and its top lines up
 * with the toolbar's. Overlap depends on viewport width (the centred bar
 * slides as the window resizes without its own box changing), so a window
 * resize listener recomputes alongside the ResizeObserver.
 */
export function wireMeasureBarClearance(bar: HTMLElement, column: HTMLElement): () => void {
  const update = (): void => {
    const h = bar.offsetHeight; // 0 while .olv-hidden (display: none)
    if (h <= 0) { column.style.setProperty('--olv-measure-bar-clear', '0px'); return; }
    const b = bar.getBoundingClientRect();
    const c = column.getBoundingClientRect();
    // Only clear vertically when the toolbar and column boxes actually meet
    // horizontally; the 8px slack matches the column's --space-md gap.
    const overlaps = b.left < c.right + 8 && b.right > c.left;
    // 8px = the column's own --space-md gap, so toolbar → first panel reads
    // with the same rhythm as panel → panel.
    column.style.setProperty('--olv-measure-bar-clear', overlaps ? `${h + 8}px` : '0px');
  };
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver(update);
      ro.observe(bar);
      ro.observe(column);
      observer = ro;
    } catch {
      /* Static layout fallback — only ancient engines, overlap is cosmetic. */
    }
  }
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) window.addEventListener('resize', update);
  update();
  // Without this the torn-down column left an observer watching a detached
  // toolbar and a resize handler firing against it forever.
  return () => {
    observer?.disconnect();
    observer = null;
    if (hasWindow) window.removeEventListener('resize', update);
  };
}

/**
 * P11 — the dock (bottom tool bar) is a separate fixed element; the left column
 * must never scroll its last control under it. Mirrors wireMeasureBarClearance:
 * writes the dock's REAL height into `--olv-dock-clear` (= dock height + its 14px
 * bottom offset + an 8px gap) so the column's max-height always ends above the
 * dock. Fallback 80px (the previous static reserve) keeps layout unchanged where
 * ResizeObserver is unavailable.
 */
export function wireDockClearance(dock: HTMLElement, column: HTMLElement): () => void {
  // The column's scroll affordance travels with it, so the composition root
  // wires the rail once rather than remembering two calls that must agree.
  const disposeRail = wireRailScrollAffordance(column, applyClassicScrollbarClass());
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver(() => {
        const h = dock.offsetHeight; // 0 while hidden (display: none)
        column.style.setProperty('--olv-dock-clear', h > 0 ? `${h + 14 + 8}px` : '80px');
      });
      ro.observe(dock);
      observer = ro;
    } catch {
      /* Static 80px fallback — only ancient engines. */
    }
  }
  // Disposes both the dock observer and the rail affordance it captured, so a
  // torn-down column leaves neither watching detached nodes.
  return () => {
    observer?.disconnect();
    observer = null;
    disposeRail();
  };
}

/**
 * Make the rail's scrollbar grabbable, but only while it has one.
 *
 * `.olv-left-panels` is the scroll container AND carries `pointer-events: none`
 * so clicks and drags in the gaps between panels reach the canvas underneath.
 * A scrollbar belongs to the scroll container, so `pointer-events: none` makes
 * the scrollbar itself un-hittable: the pointer passes straight through it.
 *
 * On macOS and this project's own test browsers that is invisible, because
 * overlay scrollbars occupy no layout width and are not dragged; the wheel goes
 * to a panel and chains to the column. On Windows the default scrollbar is a
 * classic one that takes 15px of layout and is meant to be dragged, and that
 * drag does nothing. The rail reads as stalled while the wheel still works.
 *
 * Toggling rather than simply setting `pointer-events: auto` keeps the
 * pass-through everywhere it is not paid for: the column only becomes
 * hit-testable while its content actually overflows, which is exactly when a
 * scrollbar exists for the user to reach.
 */
export function wireRailScrollAffordance(
  column: HTMLElement,
  classicScrollbars = true,
): () => void {
  // Overlay-scrollbar platforms have nothing to grab, so the class would cost
  // the canvas its pass-through in the gaps between panels and buy nothing.
  // Passed in rather than read here: platform detection belongs at the point
  // that composes the UI, and this stays testable without a document.
  if (!classicScrollbars) return () => {};
  const sync = (): void => {
    column.classList.toggle('olv-rail-scrollable', column.scrollHeight > column.clientHeight);
  };
  sync();

  const stops: Array<() => void> = [];
  // Each observer is attached on its own. An earlier revision shared one try
  // block, so a MutationObserver that refused to attach discarded a working
  // ResizeObserver and forced the column permanently hit-testable.
  try {
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(sync);
      ro.observe(column);
      stops.push(() => ro.disconnect());
    }
  } catch {
    /* Attachment refused; the other observer may still work. */
  }
  try {
    if (typeof MutationObserver !== 'undefined') {
      // Panels mount and unmount as tools open, which changes overflow without
      // ever resizing the column.
      const mo = new MutationObserver(sync);
      mo.observe(column, { childList: true, subtree: true });
      stops.push(() => mo.disconnect());
    }
  } catch {
    /* As above. */
  }

  // Nothing is watching, so overflow can change without this being re-run.
  // A scrollbar that cannot be grabbed is worse than losing pass-through in
  // the gaps between panels, so the column stays reachable.
  if (stops.length === 0) column.classList.add('olv-rail-scrollable');

  return () => {
    for (const stop of stops) stop();
    stops.length = 0;
  };
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
/**
 * Returns a disposer, same contract as wireRailScrollAffordance: it disconnects
 * the ResizeObserver, drops the window resize listener, and removes the grabber
 * this call appended. Without it a torn-down rail left an observer watching
 * detached panels and a resize handler measuring them forever.
 */
export function wireRailToggle(cfg: RailToggleConfig): () => void {
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

  let collapsed = storageGet(cfg.storageKey) === '1';
  apply(collapsed);

  // Named so the disposer can detach it. The tab is removed too, but a host
  // that keeps the node around must not keep the handler with it.
  const onClick = (): void => {
    collapsed = !collapsed;
    apply(collapsed);
    storageSet(cfg.storageKey, collapsed ? '1' : '0');
  };
  tab.addEventListener('click', onClick);
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
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    try {
      const ro = new ResizeObserver(positionTab);
      for (const p of cfg.panels) ro.observe(p);
      observer = ro;
    } catch {
      /* static fallback — the window listener + initial call still run */
    }
  }
  window.addEventListener('resize', positionTab);
  positionTab();

  return () => {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('resize', positionTab);
    tab.removeEventListener('click', onClick);
    tab.remove();
  };
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
