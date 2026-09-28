/**
 * modeHome.ts
 *
 * The Continue row at the top of each mode home (spec CE-1, CE-MODE-01). A mode
 * tab opens the home; when the mode remembers a page, the home's first row is
 * `Continue: <page> · <state>` and opens that page again. The remembered page is
 * the router's (`olv.workspace.left.page`), so no preference changes meaning.
 *
 * Presentation only: the state text is read from what is already on screen or
 * from a count the host passes in, never computed here.
 */
import { el } from '../../ui/dom';
import type { WorkspaceMode } from '../../ui/workspace/DesktopWorkspace';
import type { WorkspacePage, WorkspaceRouter } from './workspaceRouter';

type Pages = Partial<Record<WorkspaceMode, Record<string, WorkspacePage>>>;

export interface ModeHomeDeps {
  readonly router: WorkspaceRouter;
  readonly pages: Pages;
  readonly host: (m: WorkspaceMode) => HTMLElement;
  /** Open a page the way its own entry does (a tool page turns its tool on). */
  readonly open: (m: WorkspaceMode, page: string) => void;
  /** One short state for a page, for example "3 measurements"; null for none. */
  readonly stateOf: (m: WorkspaceMode, page: string) => string | null;
}

/** The row's text: `Continue: Measure · 3 measurements`. */
export function continueLabel(title: string, state: string | null): string {
  return state ? `Continue: ${title} · ${state}` : `Continue: ${title}`;
}

export interface ModeHome {
  refresh(): void;
}

export function createModeHome(d: ModeHomeDeps): ModeHome {
  const rows = new Map<WorkspaceMode, HTMLButtonElement>();
  function row(m: WorkspaceMode): HTMLButtonElement {
    let b = rows.get(m);
    if (!b) {
      b = el('button', { className: 'olv-mode-continue', type: 'button' }) as HTMLButtonElement;
      b.dataset.mode = m;
      b.addEventListener('click', () => {
        const page = d.router.remembered(m);
        if (page) d.open(m, page);
      });
      rows.set(m, b);
    }
    return b;
  }
  return {
    refresh() {
      for (const m of Object.keys(d.pages) as WorkspaceMode[]) {
        const host = d.host(m);
        const page = d.router.remembered(m);
        const b = row(m);
        const p = page ? d.pages[m]?.[page] : undefined;
        b.hidden = !p;
        b.classList.toggle('olv-ws-off', host.classList.contains('has-page'));
        if (p && page) {
          const text = continueLabel(p.title, d.stateOf(m, page));
          if (b.textContent !== text) b.textContent = text;
        }
        // First on the home, just after the task header the router keeps first.
        const first = Array.from(host.children).find((c) => !c.classList.contains('olv-ws-task')) ?? null;
        if (first !== b) host.insertBefore(b, first);
      }
    },
  };
}
