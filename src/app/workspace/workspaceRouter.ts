/**
 * workspaceRouter.ts
 *
 * Route state for the desktop left rail: `{ mode, page }`. A mode is one of the
 * workspace tabs; a page is one task inside it (the Measure panel inside Tools).
 * `page: null` is the mode's home. Each mode remembers its own page, so leaving
 * Tools for Data and coming back returns to the tool that was open.
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
  /** Return the current mode to its home. */
  back(focus?: boolean): void;
  /** Re-apply the route after a panel mounted or changed visibility. */
  sync(): void;
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
): WorkspaceRouter {
  const memory = new Map<WorkspaceMode, string | null>();
  try {
    const saved = JSON.parse(storage?.getItem(WORKSPACE_PAGE_KEY) ?? '{}') as Record<string, unknown>;
    for (const [m, p] of Object.entries(saved)) {
      if (isWorkspaceMode(m) && typeof p === 'string' && pages[m]?.[p]) memory.set(m, p);
    }
  } catch { /* unreadable preference: every mode starts at home */ }

  const headers = new Map<WorkspaceMode, { root: HTMLElement; title: HTMLElement }>();
  function header(m: WorkspaceMode): { root: HTMLElement; title: HTMLElement } {
    let h = headers.get(m);
    if (!h) {
      const backBtn = el('button', { className: 'olv-ws-back', type: 'button', text: `← ${workspaceModeLabel(m)}` });
      backBtn.setAttribute('aria-label', `Back to ${workspaceModeLabel(m)}`);
      backBtn.addEventListener('click', () => api.back(true));
      const title = el('h2', { className: 'olv-ws-task-title' });
      title.tabIndex = -1;
      title.setAttribute('aria-current', 'page');
      const root = el('nav', { className: 'olv-ws-task' }, [backBtn, title]);
      root.setAttribute('aria-label', 'Task');
      h = { root, title };
      headers.set(m, h);
    }
    return h;
  }

  /** The page actually on screen for a mode, or null when its home shows. */
  function active(m: WorkspaceMode): string | null {
    const id = memory.get(m);
    return id && shown(pages[m]?.[id]?.element(), ws.mode(m)) ? id : null;
  }

  const api: WorkspaceRouter = {
    route: () => ({ mode: ws.getMode(), page: active(ws.getMode()) }),
    navigate({ mode, page }, focus = false) {
      memory.set(mode, page);
      try {
        storage?.setItem(WORKSPACE_PAGE_KEY, JSON.stringify(Object.fromEntries(memory)));
      } catch { /* preference only */ }
      ws.setMode(mode);
      api.sync();
      if (!focus) return;
      // The heading of the page, or the first control of the home (past the header).
      const home = (Array.from(ws.mode(mode).children) as HTMLElement[])
        .find((c) => c !== headers.get(mode)?.root && !c.classList.contains('olv-ws-off'));
      const target = active(mode) ? headers.get(mode)?.title : home?.querySelector<HTMLElement>('button:not([disabled])');
      target?.focus({ preventScroll: true });
    },
    back: (focus = false) => api.navigate({ mode: ws.getMode(), page: null }, focus),
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
        }
        host.classList.toggle('has-page', !!id);
        // Home shows everything but the pages; a page shows only itself.
        const pageEls = Object.values(pages[m] ?? {}).map((p) => p.element());
        for (const child of Array.from(host.children) as HTMLElement[]) {
          if (child !== h?.root) child.classList.toggle('olv-ws-off', panel ? child !== panel : pageEls.includes(child));
        }
      }
    },
  };
  return api;
}
