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
  /**
   * A short state for a row whose tool keeps running off its page, for
   * example "On · Keep inside" for the clip box; null for none. Read on every
   * refresh, never stored here.
   */
  stateOf?: (actionId: string) => string | null;
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

  /**
   * One row per tool id, kept across refreshes. A refresh rewrites a row's
   * text and gate in place, so an unchanged row keeps its DOM identity, its
   * focus and hover, and its one click listener. The listener reads the row's
   * current action, so it never needs rebinding.
   */
  interface Row { button: HTMLButtonElement; title: HTMLElement; hint: HTMLElement; key: HTMLElement; state: HTMLElement; action: Action; fn: () => void }
  const byId = new Map<string, Row>();
  let disposed = false;
  /** Bumped per refresh; an async registry read applies only if still current. */
  let generation = 0;

  function makeRow(action: Action): Row {
    const button = el('button', { className: 'olv-tl-row', type: 'button' }) as HTMLButtonElement;
    button.title = ''; // the host's gate reason, written by render()
    const title = el('span', { className: 'olv-tl-title' });
    const hint = el('span', { className: 'olv-tl-hint' });
    const key = el('kbd', { className: 'olv-tl-key' });
    const state = el('span', { className: 'olv-tl-state' });
    button.append(title, hint, key, state);
    const row: Row = { button, title, hint, key, state, action, fn: () => {} };
    row.fn = (): void => {
      if (button.disabled) return;
      if (!deps.resume?.(row.action.id)) row.action.run();
    };
    button.addEventListener('click', row.fn);
    return row;
  }

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
    node.hidden = !text;
  }

  function render(actions: readonly Action[]): void {
    if (disposed) return;
    const reason = deps.disabledReason?.() ?? null;
    const order: HTMLElement[] = [];
    const seen = new Set<string>();
    for (const id of TOOL_IDS) {
      const action = actions.find((a) => a.id === id);
      if (!action) continue;
      seen.add(id);
      let row = byId.get(id);
      if (!row) { row = makeRow(action); byId.set(id, row); }
      row.action = action;
      setText(row.title, action.title);
      setText(row.hint, action.hint ?? '');
      setText(row.key, action.keys ?? '');
      const on = deps.stateOf?.(id) ?? null;
      setText(row.state, on ?? '');
      row.button.classList.toggle('is-on', on !== null);
      row.button.disabled = !!reason;
      row.button.title = reason ?? '';
      order.push(row.button);
    }
    for (const [id, row] of byId) {
      if (seen.has(id)) continue;
      row.button.removeEventListener('click', row.fn);
      row.button.remove();
      byId.delete(id);
    }
    // Re-append only when the order changed, so a focused row is never moved.
    const current = Array.from(rows.children);
    if (current.length !== order.length || order.some((n, i) => current[i] !== n)) rows.replaceChildren(...order);
    const c = deps.counts();
    countsValue.textContent = `${plural(c.measurements, 'measurement')} · ${plural(c.annotations, 'annotation')}`;
  }

  function refresh(): void {
    if (disposed) return;
    const gen = ++generation;
    const actions = deps.getActions();
    if (Array.isArray(actions)) render(actions as readonly Action[]);
    // A registry chunk that fails to load (a reload mid-fetch, a dropped
    // connection) leaves the rows as they are; the next refresh asks again.
    else void Promise.resolve(actions).then((list) => { if (gen === generation) render(list); }, () => {});
  }

  refresh();

  return {
    element,
    refresh,
    dispose: () => {
      disposed = true;
      generation++;
      for (const row of byId.values()) row.button.removeEventListener('click', row.fn);
      byId.clear();
      rows.replaceChildren();
    },
  };
}
