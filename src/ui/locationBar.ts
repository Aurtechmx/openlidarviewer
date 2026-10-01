/**
 * locationBar.ts
 *
 * Where you are and how to get back (spec CE-1, sections 3 and 4). It rides
 * the workspace shell chunk, never the startup script, and mounts with the
 * first scan. Its stylesheet is `wayfinding.css`.
 *
 * - The location bar: one line of crumbs after the product mark in the top
 *   bar, and the same line as the heading of the phone sheet in every detent.
 *   The crumbs come from `locationCrumbs` (route + page registry + workspace
 *   names), so no surface sets their text. Every crumb but the last is a
 *   button; the last carries `aria-current="location"`. A Back control leads
 *   the bar on every surface below a mode home and names its destination, so
 *   a collapsed rail or a lowered sheet never hides the way back.
 * - Route changes are announced once through the shared polite region.
 * - Escape is Back, except in a text field, during a drag, while a tool is
 *   capturing or a popover is open (those handle Escape first), and inside a
 *   dialog, which closes itself.
 * - Going back returns focus to the control that opened the surface.
 * - Each open workspace gets a visible "Close <name>" at its top.
 * - The command palette's "Go to" entries come from the same registry: the
 *   palette asks for them with an `olv-palette-open` event each time it opens.
 * - Labs and result focus get a Back that names where they return, and
 *   opening the palette or a result focus closes an open popover first.
 *
 * Presentation only: it navigates through the router and the existing tool
 * and analysis entries, and never starts or changes a computation.
 */

import { el } from './dom';
import { announcePolite } from './politeAnnounce';
import { workspaceModeLabel, type WorkspaceMode } from './workspace/DesktopWorkspace';
import type { WorkspacePage, WorkspaceRouter } from '../app/workspace/workspaceRouter';
import {
  backTarget,
  locationCrumbs,
  CRUMB_SEPARATOR,
  WORKSPACES,
  type Crumb,
  type LocationRegistry,
  type LocationRoute,
} from '../app/workspace/locationModel';
import type { Action } from './actionRegistry';
import { closeTransients, labelModalBack, SURFACE_DIALOGS } from './exitConvention';
import { MOBILE_LAYOUT_QUERY } from './isMobileDevice';

type Pages = Partial<Record<WorkspaceMode, Record<string, WorkspacePage>>>;
type AnalysePageId = 'terrain' | 'contours' | 'objects' | 'features' | 'range' | 'flow-pulse' | 'terrain-access' | 'observatory';

export interface LocationBarDeps {
  readonly router: WorkspaceRouter;
  readonly pages: Pages;
  /** The phone sheet's root; the bar is placed in its head. */
  readonly sheet: HTMLElement | null;
  readonly hasScan: () => boolean;
  readonly isMobile: () => boolean;
  /** Run a registered action by id (the tool entries). */
  readonly runAction: (id: string) => void;
  /** Mount what an Analyse page needs, then show it. */
  readonly openAnalysePage: (page: AnalysePageId) => unknown;
  readonly doc?: Document;
}

/**
 * The shell's entry point: positional, so the eager call site stays small.
 * Scan presence and the phone layout are read from the page itself: the rail
 * is marked ready once a scan is open, and the layout query is the one the
 * shell and the stylesheet share.
 */
export function mountLocationBar(router: WorkspaceRouter, pages: Pages, runAction: (id: string) => void, openAnalysePage: (page: AnalysePageId) => unknown): LocationBar {
  const mql = typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_LAYOUT_QUERY) : null;
  const bar = createLocationBar({
    router,
    pages,
    sheet: document.querySelector<HTMLElement>('.olv-mobile-sheet'),
    hasScan: () => !!document.querySelector('.olv-left-panels.olv-ws-ready'),
    isMobile: () => mql?.matches ?? false,
    runAction,
    openAnalysePage,
  });
  const onChange = (): void => bar.update();
  mql?.addEventListener('change', onChange);
  return { update: bar.update, dispose: () => { mql?.removeEventListener('change', onChange); bar.dispose(); } };
}

/** Where each registered workspace lives on screen, and how it opens and closes. */
const WORKSPACE_DOM: Readonly<Record<string, { root: string; launcher: string; close?: string }>> = {
  'contour-studio': { root: '.olv-analyse-contour-deliverable', launcher: '.olv-analyse-contour-launcher .olv-contour-launcher-action' },
  'range-workbench': { root: '.olv-analyse-range-workbench', launcher: '.olv-analyse-range-launcher button' },
  'feature-review': { root: '.olv-analyse-feature-review', launcher: '.olv-analyse-feature-launcher button' },
  'profile-workbench': { root: '.olv-workbench', launcher: '.olv-mp-chart-wrap', close: '.olv-workbench-close' },
};

const LAB_PAGES = new Set(['flow-pulse', 'terrain-access', 'observatory']);
const ANALYSE_PAGES = new Set(['terrain', 'contours', 'objects', 'features', 'range', ...LAB_PAGES]);

/** Text fields keep Escape for themselves. */
function editable(node: Element | null): boolean {
  if (!node) return false;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((node as HTMLInputElement).type ?? '').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(type);
  }
  return (node as HTMLElement).isContentEditable === true;
}

function visible(node: Element | null | undefined): node is HTMLElement {
  return !!node && (node as HTMLElement).isConnected && (node as HTMLElement).getClientRects().length > 0;
}

const sameRoute = (a: LocationRoute, b: LocationRoute): boolean => a.mode === b.mode && a.page === b.page;

export interface LocationBar {
  /** Re-read the route and repaint now. */
  update(): void;
  dispose(): void;
}

export function createLocationBar(d: LocationBarDeps): LocationBar {
  const doc = d.doc ?? document;
  const registry: LocationRegistry = { modeLabel: workspaceModeLabel, pages: d.pages, workspaces: WORKSPACES };

  /** The open workspace on the current route, if any. */
  function openWorkspace(route: LocationRoute): string | null {
    for (const [id, ws] of Object.entries(WORKSPACES)) {
      if (ws.mode !== route.mode || ws.page !== route.page) continue;
      const root = doc.querySelector<HTMLElement>(WORKSPACE_DOM[id].root);
      if (root?.isConnected && !root.classList.contains('olv-hidden') && root.childElementCount > 0) return id;
    }
    return null;
  }

  // ── focus return ──────────────────────────────────────────────────────────
  let lastTarget: HTMLElement | null = null;
  const record = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (t && typeof t.closest === 'function') lastTarget = t.closest<HTMLElement>('button, [role="button"], a, [tabindex]') ?? t;
  };
  let dragging = false;
  const down = (e: Event): void => { record(e); dragging = true; };
  const up = (): void => { dragging = false; };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', up, true);
  doc.addEventListener('keydown', record, true);
  /** Opener of each location, keyed by its path. */
  const openers = new Map<string, HTMLElement>();
  /** Set while this module (or a Back control) is taking the user back. */
  let returning = false;

  // ── rendering ─────────────────────────────────────────────────────────────
  function buildBar(): { nav: HTMLElement; back: HTMLButtonElement; list: HTMLElement } {
    const back = el('button', { className: 'olv-loc-back', type: 'button', tip: 'Go back one level. Escape does the same.' }) as HTMLButtonElement;
    back.addEventListener('click', (e) => { e.stopPropagation(); goBack(); });
    const list = el('ol', { className: 'olv-loc-crumbs' });
    const nav = el('nav', { className: 'olv-loc' }, [back, list]);
    nav.setAttribute('aria-label', 'Location');
    // In the sheet head, a tap here is navigation, not a resize of the sheet.
    nav.addEventListener('pointerdown', (e) => e.stopPropagation());
    nav.addEventListener('click', (e) => e.stopPropagation());
    nav.hidden = true;
    return { nav, back, list };
  }
  const top = buildBar();
  const phone = buildBar();
  doc.querySelector('.olv-topbar .olv-wordmark')?.after(top.nav);
  d.sheet?.querySelector('.olv-msheet-head')?.prepend(phone.nav);

  function paint(bar: ReturnType<typeof buildBar>, crumbs: Crumb[], route: LocationRoute, ws: string | null, show: boolean): void {
    bar.nav.hidden = !show;
    const here = crumbs[crumbs.length - 1];
    bar.nav.dataset.path = here?.path ?? '';
    bar.nav.dataset.here = here?.label ?? '';
    // A mode home's single crumb repeats the active mode tab, so it reads as
    // plain text rather than a second pill beside the tab (CE-LOC-01).
    bar.nav.classList.toggle('is-mode-home', crumbs.length === 1);
    const b = backTarget(route, registry, ws);
    bar.back.hidden = !b;
    if (b) {
      bar.back.textContent = b.label;
      bar.back.setAttribute('aria-label', b.name);
    }
    const items: HTMLElement[] = [];
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = el('li', { className: 'olv-loc-sep', text: CRUMB_SEPARATOR.trim() });
        sep.setAttribute('aria-hidden', 'true');
        items.push(sep);
      }
      if (c.to) {
        const btn = el('button', { className: 'olv-loc-crumb', type: 'button', text: c.label, ariaLabel: c.path });
        const to = c.to;
        btn.addEventListener('click', (e) => { e.stopPropagation(); goTo(to); });
        items.push(el('li', {}, [btn]));
      } else {
        const cur = el('span', { className: 'olv-loc-here', text: c.label });
        cur.setAttribute('aria-current', 'location');
        // The full path for assistive technology; the visible text is the label.
        const prefix = c.path.slice(0, c.path.length - c.label.length);
        if (prefix) cur.prepend(el('span', { className: 'olv-visually-hidden', text: prefix }));
        items.push(el('li', {}, [cur]));
      }
    });
    bar.list.replaceChildren(...items);
  }

  let lastKey: string | null = null;
  let lastPath = '';
  function update(): void {
    const route = d.router.route();
    const ws = openWorkspace(route);
    const crumbs = locationCrumbs(route, registry, ws);
    const scan = d.hasScan();
    const mobile = d.isMobile();
    const key = `${scan}|${mobile}|${crumbs.map((c) => c.label).join('/')}`;
    if (key === lastKey) return;
    lastKey = key;
    paint(top, crumbs, route, ws, scan && !mobile);
    paint(phone, crumbs, route, ws, scan && mobile);
    for (const inst of Object.keys(WORKSPACE_DOM)) closeControl(inst);
    const path = crumbs[crumbs.length - 1]?.path ?? '';
    if (path !== lastPath) {
      const before = lastPath;
      lastPath = path;
      if (before && scan) {
        announcePolite(`Location: ${crumbs.map((c) => c.label).join(', ')}`, doc);
        onMoved(before, path);
      }
    }
  }

  /** Remember who opened a deeper place; restore focus when coming back. */
  function onMoved(from: string, to: string): void {
    const deeper = to.startsWith(`${from}${CRUMB_SEPARATOR}`);
    if (deeper) {
      if (lastTarget) openers.set(to, lastTarget); // a repainted row is found again on the way back
      return;
    }
    const viaBack = returning || !!lastTarget?.closest('.olv-ws-back, .olv-loc-back, .olv-loc-crumb, .olv-ws-close, .olv-workbench-close');
    returning = false;
    // The opener of the place just left, or of the deepest place above where we are now.
    // A home that repainted its rows while away holds a new node for the same row.
    const opener = current(openers.get(from));
    for (const k of Array.from(openers.keys())) if (!to.startsWith(k) || k === to) openers.delete(k);
    if (!viaBack) return;
    if (visible(opener) && !opener.closest('[aria-hidden="true"]')) {
      opener.focus({ preventScroll: true });
      return;
    }
    // The opener is out of view (a collapsed rail, a lowered sheet): keep focus on the bar.
    const bar = d.isMobile() ? phone : top;
    bar.nav.querySelector<HTMLElement>('.olv-loc-back:not([hidden])')?.focus({ preventScroll: true });
  }

  /** The live node for an opener: itself, or the same Analyse row's button after a repaint. */
  function current(node: HTMLElement | undefined): HTMLElement | undefined {
    if (!node || node.isConnected) return node;
    const id = node.closest<HTMLElement>('[data-analysis]')?.dataset.analysis;
    return (id && doc.querySelector<HTMLElement>(`.olv-ah-row[data-analysis="${id}"] .olv-ah-open`)) || node;
  }

  // ── navigation ────────────────────────────────────────────────────────────
  /** On a phone, a navigation from the bar or the palette shows its page: a sheet at peek is raised. */
  function reveal(): void {
    if (!d.isMobile() || d.sheet?.dataset.detent !== 'peek') return;
    d.sheet.querySelector<HTMLElement>('.olv-msheet-handle')?.click();
  }
  function closeWorkspace(id: string): void {
    const dom = WORKSPACE_DOM[id];
    returning = true;
    if (dom.close) {
      doc.querySelector<HTMLElement>(dom.close)?.click();
    } else {
      doc.querySelector<HTMLElement>(dom.root)?.classList.add('olv-hidden');
    }
    schedule();
  }

  function goTo(to: LocationRoute): void {
    const route = d.router.route();
    const ws = openWorkspace(route);
    returning = true;
    if (sameRoute(to, route)) {
      if (ws) closeWorkspace(ws);
      return;
    }
    d.router.navigate(to);
    reveal();
    schedule();
  }

  function goBack(): boolean {
    const route = d.router.route();
    const ws = openWorkspace(route);
    const b = backTarget(route, registry, ws);
    if (!b) return false;
    if (b.kind === 'workspace') closeWorkspace(b.id);
    else goTo(b.to);
    return true;
  }

  /** A workspace's own "Close <name>" at its top. */
  function closeControl(id: string): void {
    const root = doc.querySelector<HTMLElement>(WORKSPACE_DOM[id].root);
    if (!root || WORKSPACE_DOM[id].close || root.querySelector(':scope > .olv-ws-close')) return;
    const name = WORKSPACES[id].name;
    const b = el('button', { className: 'olv-ws-close', type: 'button', text: `Close ${name}`, tip: `Close ${name} and return to its page. Its settings are kept.` });
    b.addEventListener('click', () => closeWorkspace(id));
    root.prepend(b);
  }

  // ── Escape is Back ────────────────────────────────────────────────────────
  // Decided in the capture phase, before any other handler has changed state;
  // acted on in the bubble phase, only if nothing inner handled the key.
  let escapeBack = false;
  const onEscapeCapture = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    const t = e.target as Element | null;
    const popover = doc.querySelector('.olv-tool-more[aria-expanded="true"], [aria-haspopup][aria-expanded="true"]');
    const capturing = doc.querySelector('.olv-dock [aria-pressed="true"]:not(.olv-tool-analyse)');
    const owned = t && typeof t.closest === 'function' && t.closest('[role="dialog"], .olv-results-shelf, .olv-workbench, .olv-context-menu, .olv-palette');
    escapeBack = !e.repeat && !editable(t) && !dragging && !popover && !capturing && !owned && d.hasScan();
  };
  const onEscapeBubble = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !escapeBack || e.defaultPrevented) return;
    escapeBack = false;
    if (doc.querySelector('.olv-modal-backdrop, .olv-palette:not(.olv-hidden)')) return;
    if (goBack()) e.preventDefault();
  };
  doc.addEventListener('keydown', onEscapeCapture, true);
  const win = doc.defaultView;
  win?.addEventListener('keydown', onEscapeBubble);

  // ── palette Go to ─────────────────────────────────────────────────────────
  function reasonFor(mode: WorkspaceMode, page: string): string | undefined {
    if (!d.hasScan()) return 'Open a scan first.';
    if (mode === 'analyse') {
      const row = doc.querySelector<HTMLElement>(`.olv-ah-row[data-analysis="${page}"]`);
      const reason = row?.querySelector('.olv-ah-reason')?.textContent?.trim();
      // A lab page opens even when blocked: it says what it needs and offers the fix.
      if (row?.classList.contains('is-blocked') && !LAB_PAGES.has(page)) return reason || 'Not available for this scan yet.';
      // Feature candidates and Range frames exist only when the scan carries their data.
      const shell = doc.querySelector(`.olv-analyse-page[data-page="${page}"]`);
      if ((page === 'features' || page === 'range') && shell?.classList.contains('olv-hidden')) return reason || 'Not available for this scan.';
    }
    return undefined;
  }
  function openPage(mode: WorkspaceMode, page: string): void {
    reveal();
    const target = d.pages[mode]?.[page]?.element();
    if (mode === 'analyse' && ANALYSE_PAGES.has(page)) {
      void d.openAnalysePage(page as AnalysePageId);
    } else if (mode === 'work' && !(target && !target.classList.contains('olv-hidden') && target.style.display !== 'none')) {
      d.runAction(`tool.${page}`); // the tool opens its own page
    } else {
      d.router.navigate({ mode, page }, true);
    }
  }
  const goToActions = (): Action[] => {
    const out: Action[] = [];
    for (const [mode, list] of Object.entries(d.pages) as [WorkspaceMode, Record<string, WorkspacePage>][]) {
      for (const [page, p] of Object.entries(list)) {
        if (p.palette === false) continue;
        const unavailable = reasonFor(mode, page);
        out.push({
          id: `goto.${mode}.${page}`,
          title: `Go to ${p.title}`,
          section: 'Go to',
          hint: locationCrumbs({ mode, page }, registry).map((c) => c.label).join(CRUMB_SEPARATOR),
          keywords: [workspaceModeLabel(mode), p.title],
          ...(unavailable ? { unavailable } : {}),
          run: () => openPage(mode, page),
        });
      }
    }
    for (const [id, ws] of Object.entries(WORKSPACES)) {
      const launcher = doc.querySelector<HTMLButtonElement>(WORKSPACE_DOM[id].launcher);
      const unavailable = !d.hasScan()
        ? 'Open a scan first.'
        : !launcher || launcher.disabled
          ? id === 'profile-workbench'
            ? 'Draw a profile with Measure first.'
            : 'Run the terrain analysis first; it opens from its page when available.'
          : undefined;
      out.push({
        id: `goto.workspace.${id}`,
        title: `Go to ${ws.name}`,
        section: 'Go to',
        hint: locationCrumbs({ mode: ws.mode, page: ws.page }, registry, id).map((c) => c.label).join(CRUMB_SEPARATOR),
        keywords: [ws.name],
        ...(unavailable ? { unavailable } : {}),
        run: () => {
          if (ws.mode === 'analyse') void d.openAnalysePage(ws.page as AnalysePageId);
          else openPage(ws.mode, ws.page);
          // The launcher sits on the page just opened; its click opens the workspace.
          setTimeout(() => doc.querySelector<HTMLButtonElement>(WORKSPACE_DOM[id].launcher)?.click(), 0);
        },
      });
    }
    return out;
  };
  // The palette asks on every open: the entries reflect the scan and route of that moment.
  const onPaletteOpen = (e: Event): void => {
    closeTransients(e.target as Element);
    (e as CustomEvent<{ add?: (list: readonly Action[]) => void }>).detail?.add?.(goToActions());
  };
  doc.addEventListener('olv-palette-open', onPaletteOpen);

  /**
   * A dialog that holds a surface leads with a named Back, and a result focus
   * closes other transients. The control that opened it is kept: a browser
   * that does not focus a clicked button (Safari) leaves the dialog nothing to
   * restore, so focus goes back to that control when the dialog leaves.
   */
  const dialogOpeners = new Map<Node, HTMLElement>();
  function watchDialogs(records: MutationRecord[]): void {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        const node = n as HTMLElement;
        if (typeof node.matches !== 'function' || !node.matches(SURFACE_DIALOGS)) continue;
        if (node.matches('.olv-result-focus')) closeTransients(node, doc);
        labelModalBack(node, doc);
        if (lastTarget?.isConnected && !node.contains(lastTarget)) dialogOpeners.set(node, lastTarget);
      }
      for (const n of Array.from(r.removedNodes)) {
        const opener = dialogOpeners.get(n);
        if (!opener) continue;
        dialogOpeners.delete(n);
        const active = doc.activeElement;
        if ((!active || active === doc.body) && visible(opener)) opener.focus({ preventScroll: true });
      }
    }
  }

  // ── change detection ──────────────────────────────────────────────────────
  // The router changes classes on live panels and the workspaces show and hide
  // theirs, so one observer over the document catches every route and
  // workspace change; repaints are coalesced to one per frame.
  let frame = 0;
  function schedule(): void {
    if (frame) return;
    const raf = win?.requestAnimationFrame?.bind(win) ?? ((fn: FrameRequestCallback) => setTimeout(() => fn(0), 16) as unknown as number);
    frame = raf(() => { frame = 0; update(); });
  }
  const mo = typeof MutationObserver === 'function'
    ? new MutationObserver((records) => {
      watchDialogs(records);
      schedule();
    })
    : null;
  mo?.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
  update();

  return {
    update,
    dispose() {
      mo?.disconnect();
      doc.removeEventListener('olv-palette-open', onPaletteOpen);
      doc.removeEventListener('pointerdown', down, true);
      doc.removeEventListener('pointerup', up, true);
      doc.removeEventListener('pointercancel', up, true);
      doc.removeEventListener('keydown', record, true);
      doc.removeEventListener('keydown', onEscapeCapture, true);
      win?.removeEventListener('keydown', onEscapeBubble);
      top.nav.remove();
      phone.nav.remove();
    },
  };
}
