/**
 * toolLauncher.ts
 *
 * The card at the head of the Tools tab. The tab used to show only the Clip
 * box until a tool had already been used, so it could not say what the tab was
 * for. This lists the scene tools with their keys and what the session already
 * holds, and runs each one.
 *
 * Every row is read from the action registry (`actionRegistry.ts`): the title,
 * the one-line hint and the key chip come from the same descriptor the command
 * palette and Help read, so a tool renamed or re-keyed once is renamed here
 * too. The card owns no tool state, adds no count of its own, and changes no
 * scientific value: the counts come from the measurement controller and the
 * annotation store through `deps.counts()`.
 *
 * The card is the Tools home; a tool's page replaces it rather than sharing
 * the column with it. `refresh()` re-reads the registry and the counts.
 *
 * Pure DOM via {@link el}; no three.js and no app singletons, so it is
 * unit-testable against the recording document the other UI tests use.
 */

import { el } from './dom';
import type { Action } from './actionRegistry';

/**
 * The tool rows, in the order the card shows them. Ids absent from the
 * registry are skipped rather than rendered empty, so a build without one of
 * these tools simply lists the rest.
 */
const TOOL_IDS: readonly string[] = [
  'tool.measure',
  'tool.inspect',
  'tool.probe',
  'tool.annotate',
  'tool.clip',
];

export interface ToolLauncherCounts {
  readonly measurements: number;
  readonly annotations: number;
}

export interface ToolLauncherDeps {
  /** The action registry, which the shell builds lazily. */
  getActions: () => Promise<readonly Action[]> | readonly Action[];
  /** Canonical session counts, read live on every refresh. */
  counts: () => ToolLauncherCounts;
  /**
   * Why a tool cannot run right now, or `null` when it can. The host owns this
   * gate, the way the tool dock's `setEnabled` does.
   */
  disabledReason?: () => string | null;
  /**
   * Reopen a tool that is already on instead of switching it off. Returns true
   * when it handled the row. The launcher is the Tools home, so a row there is
   * a way back into a running tool; the palette and keys keep their toggle.
   */
  resume?: (actionId: string) => boolean;
}

export interface ToolLauncher {
  /** The card element the workspace mounts. */
  readonly element: HTMLElement;
  /** Re-read the registry, the counts and the active state, then redraw. */
  refresh(): void;
  /** Detach every row listener. */
  dispose(): void;
}

/** `3 measurements` / `1 measurement`. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function createToolLauncher(deps: ToolLauncherDeps): ToolLauncher {
  const rows = el('div', { className: 'olv-tl-rows' });
  const counts = el('div', { className: 'olv-tl-counts' });
  const countsValue = el('span', { className: 'olv-tl-counts-value' });
  counts.append(el('span', { className: 'olv-tl-counts-label', text: 'Placed so far' }), countsValue);
  const head = el('div', { className: 'olv-tl-head', text: 'Tools' });
  const element = el('section', { className: 'olv-tool-launcher' }, [head, rows, counts]);
  element.setAttribute('aria-label', 'Tools');

  const bound: Array<{ node: HTMLElement; fn: () => void }> = [];
  let disposed = false;

  function clearRows(): void {
    for (const { node, fn } of bound) node.removeEventListener('click', fn);
    bound.length = 0;
    rows.replaceChildren();
  }

  function addRow(action: Action, reason: string | null): void {
    const chip = action.keys ? el('kbd', { className: 'olv-tl-key', text: action.keys }) : null;
    const button = el('button', { className: 'olv-tl-row', type: 'button' }) as HTMLButtonElement;
    button.append(el('span', { className: 'olv-tl-title', text: action.title }));
    if (action.hint) button.append(el('span', { className: 'olv-tl-hint', text: action.hint }));
    if (chip) button.append(chip);
    if (reason) {
      button.disabled = true;
      button.title = reason;
    } else {
      const fn = (): void => { if (!deps.resume?.(action.id)) action.run(); };
      button.addEventListener('click', fn);
      bound.push({ node: button, fn });
    }
    rows.append(button);
  }

  function render(actions: readonly Action[]): void {
    if (disposed) return;
    const reason = deps.disabledReason?.() ?? null;
    clearRows();
    for (const id of TOOL_IDS) {
      const action = actions.find((a) => a.id === id);
      if (action) addRow(action, reason);
    }
    const c = deps.counts();
    countsValue.textContent = `${plural(c.measurements, 'measurement')} · ${plural(c.annotations, 'annotation')}`;
  }

  function refresh(): void {
    if (disposed) return;
    const actions = deps.getActions();
    if (Array.isArray(actions)) render(actions as readonly Action[]);
    else void Promise.resolve(actions).then(render);
  }

  refresh();

  return {
    element,
    refresh,
    dispose: () => {
      disposed = true;
      clearRows();
    },
  };
}
