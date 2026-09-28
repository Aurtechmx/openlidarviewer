/**
 * workspaceRouter.ts
 *
 * Route state for the desktop left rail: `{ mode, page }`. A mode is one of the
 * workspace tabs; a page is one task inside it (the Measure panel inside Tools).
 * `page: null` is the mode's home. Each mode remembers its last page: going
 * home keeps it, and the home offers it back as a Continue row
 * (`modeHome.ts`). A mode tab opens the home (spec CE-1, CE-MODE-01).
 *
 * Presentation only. Navigating toggles classes on panels that are already
 * live in the mode host; it never creates, moves or refreshes a panel and never
 * calls into a tool, so a route change cannot start or invalidate a
 * computation. There is no URL or history entry: `back()` always returns to the
 * current mode's home, which keeps it deterministic.
 *
 * While a page is shown, a task header (`<- Tools  MEASURE`) leads the host and
 * every other child of the host carries `olv-ws-off`; at home the page panels
 * carry it instead, so the home (the Tools launcher) stands alone. The phone
 * sheet hosts these same mode containers in its tabs, so one route drives both
 * presentations.
 */

import { el } from '../../ui/dom';
import {
  isWorkspaceMode,
  workspaceModeLabel,
  type WorkspaceMode,
  type WorkspaceStorage,
} from '../../ui/workspace/DesktopWorkspace';

export interface WorkspaceRoute {
  readonly mode: WorkspaceMode;
  readonly page: string | null;
}

/** A task page: its heading and the live panel it shows. */
export interface WorkspacePage {
  readonly title: string;
  readonly element: () => HTMLElement | null | undefined;
  /** The page Back returns to. It must be a top-level page of the same mode. */
  readonly parent?: string;
}

/** The slice of {@link DesktopWorkspace} the router drives. */
export interface RouterWorkspace {
  getMode(): WorkspaceMode;
  setMode(m: WorkspaceMode): void;
  mode(m: WorkspaceMode): HTMLElement;
}

/** Optional per-mode page memory, beside (never inside) the mode key. */
export const WORKSPACE_PAGE_KEY = 'olv.workspace.left.page';

export interface WorkspaceRouter {
  route(): WorkspaceRoute;
  /** Show a route. `focus` moves focus to the task heading (or home). */
  navigate(route: WorkspaceRoute, focus?: boolean): void;
  /** Return to the current page's parent, or to the mode's home. */
  back(focus?: boolean): void;
  /** Re-apply the route after a panel mounted or changed visibility. */
  sync(): void;
  /** The page a mode remembers, shown or not; null when it has none. */
  remembered(mode: WorkspaceMode): string | null;
}

type Pages = Partial<Record<WorkspaceMode, Record<string, WorkspacePage>>>;

/** A page is showable when its panel is in the host and not hidden by its owner. */
function shown(node: HTMLElement | null | undefined, host: HTMLElement): node is HTMLElement {
  return !!node && node.parentElement === host && !node.classList.contains('olv-hidden') && node.style.display !== 'none';
}

export function createWorkspaceRouter(
  ws: RouterWorkspace,
  pages: Pages,
  storage: WorkspaceStorage | null = null,
  onSync?: () => void,
): WorkspaceRouter {
  for (const [m, list] of Object.entries(pages)) {
    for (const [id, p] of Object.entries(list ?? {})) {
      const parent = p.parent === undefined ? undefined : list?.[p.parent];
      if (p.parent !== undefined && (!parent || parent.parent !== undefined)) {
        throw new Error(`Workspace page ${m}/${id}: a parent must be a top-level page of the same mode`);
      }
    }
  }
  const memory = new Map<WorkspaceMode, string | null>();
  /** Modes showing their home while they still remember a page. */
  const atHome = new Set<WorkspaceMode>();
  try {
    const saved = JSON.parse(storage?.getItem(WORKSPACE_PAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const [m, p] of Object.entries(saved)) {
      if (isWorkspaceMode(m) && typeof p === 'string' && pages[m]?.[p]) memory.set(m, p);
    }
  } catch { /* unreadable preference: every mode starts at home */ }

  type Header = { root: HTMLElement; title: HTMLElement; back: HTMLElement };
  const headers = new Map<WorkspaceMode, Header>();
  function header(m: WorkspaceMode): Header {
    let h = headers.get(m);
    if (!h) {
      const backBtn = el('button', { className: 'olv-ws-back', type: 'button' });
      backBtn.addEventListener('click', () => api.back(true));
      const title = el('h2', { className: 'olv-ws-task-title' });
      title.tabIndex = -1;
      title.setAttribute('aria-current', 'page');
      const root = el('nav', { className: 'olv-ws-task' }, [backBtn, title]);
      root.setAttribute('aria-label', 'Task');
      h = { root, title, back: backBtn };
      headers.set(m, h);
    }
    return h;
  }

  /** The page actually on screen for a mode, or null when its home shows. */
  function active(m: WorkspaceMode): string | null {
    const id = atHome.has(m) ? null : memory.get(m);
    return id && shown(pages[m]?.[id]?.element(), ws.mode(m)) ? id : null;
  }

  /**
   * Mark the host with the direction of a page change, for the stylesheet's
   * short entry transition. Deeper is forward; home or a parent is back. The
   * mark clears itself, so a later tab switch does not replay it.
   */
  let navTimer: ReturnType<typeof setTimeout> | undefined;
  function markDirection(mode: WorkspaceMode, from: string | null, to: string | null): void {
    if (from === to) return;
    const host = ws.mode(mode);
    const back = to === null || (from !== null && pages[mode]?.[from]?.parent === to);
    // A new page starts at its top, so its title and Back are on screen: the
    // scroller (the rail body, or the phone sheet's tab) keeps the old offset.
    for (let p = host.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
      if (p.scrollTop > 0) p.scrollTop = 0;
    }
    host.classList.toggle('olv-ws-nav-forward', !back);
    host.classList.toggle('olv-ws-nav-back', back);
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      host.classList.remove('olv-ws-nav-forward');
      host.classList.remove('olv-ws-nav-back');
    }, 400);
  }

  const api: WorkspaceRouter = {
    route: () => ({ mode: ws.getMode(), page: active(ws.getMode()) }),
    navigate({ mode, page }, focus = false) {
      if (ws.getMode() === mode) markDirection(mode, active(mode), page);
      // Home keeps the remembered page (and its stored key) for Continue.
      if (page === null) atHome.add(mode);
      else { atHome.delete(mode); memory.set(mode, page); }
      try {
        storage?.setItem(WORKSPACE_PAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
      } catch { /* preference only */ }
      ws.setMode(mode);
      api.sync();
      if (!focus) return;
      // The heading of the page, or the first control of the home (past the header).
      const home = (Array.from(ws.mode(mode).children) as HTMLElement[])
        .find((c) => c !== headers.get(mode)?.root && !c.classList.contains('olv-ws-off') && !c.hidden);
      const target = active(mode) ? headers.get(mode)?.title : home?.tagName === 'BUTTON' ? home : home?.querySelector<HTMLElement>('button:not([disabled])');
      target?.focus({ preventScroll: true });
    },
    back(focus = false) {
      const mode = ws.getMode();
      const id = active(mode);
      api.navigate({ mode, page: (id && pages[mode]?.[id]?.parent) ?? null }, focus);
    },
    remembered: (m) => {
      const id = memory.get(m) ?? null;
      return id && pages[m]?.[id] ? id : null;
    },
    sync() {
      for (const m of Object.keys(pages) as WorkspaceMode[]) {
        const host = ws.mode(m);
        const id = active(m);
        const panel = id ? pages[m]?.[id]?.element() : null;
        const h = id || headers.has(m) ? header(m) : null;
        if (h) {
          if (host.firstChild !== h.root) host.insertBefore(h.root, host.firstChild);
          h.root.hidden = !id;
          h.title.textContent = id ? pages[m]?.[id]?.title ?? '' : '';
          const parent = id ? pages[m]?.[id]?.parent : undefined;
          const to = parent ? pages[m]?.[parent]?.title ?? '' : workspaceModeLabel(m);
          h.back.textContent = `← ${to}`;
          h.back.setAttribute('aria-label', `Back to ${to}`);
        }
        host.classList.toggle('has-page', !!id);
        // Home shows everything but the pages; a page shows only itself.
        const pageEls = Object.values(pages[m] ?? {}).map((p) => p.element());
        for (const child of Array.from(host.children) as HTMLElement[]) {
          if (child !== h?.root) child.classList.toggle('olv-ws-off', panel ? child !== panel : pageEls.includes(child));
        }
      }
      onSync?.();
    },
  };
  return api;
}

/**
 * Whether a navigation was started from inside the rail, so the router should
 * move focus to the new task heading.
 *
 * Focus alone is not enough: Safari does not focus a button on mouse click,
 * so after a click in the rail `document.activeElement` is still <body>. The
 * last pointerdown or keydown target is recorded as well, and a navigation
 * that follows it within the same interaction counts as started in the rail.
 * A focused text field is never taken over.
 */
const WINDOW_MS = 1000;

const NON_TEXT = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'];

function editable(node: Element | null): boolean {
  if (!node) return false;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT.includes(((node as HTMLInputElement).type ?? '').toLowerCase());
  return (node as HTMLElement).isContentEditable === true;
}

export function createRailIntent(
  rail: HTMLElement,
  doc: Document = document,
  now: () => number = () => Date.now(),
): { startedInRail(): boolean; dispose(): void } {
  let last: { target: Node; at: number } | null = null;
  const record = (e: Event): void => {
    last = e.target ? { target: e.target as Node, at: now() } : null;
  };
  doc.addEventListener('pointerdown', record, true);
  doc.addEventListener('keydown', record, true);
  return {
    startedInRail() {
      const active = doc.activeElement;
      if (editable(active)) return false;
      if (active && rail.contains(active)) return true;
      return !!last && now() - last.at <= WINDOW_MS && rail.contains(last.target);
    },
    dispose() {
      doc.removeEventListener('pointerdown', record, true);
      doc.removeEventListener('keydown', record, true);
    },
  };
}
