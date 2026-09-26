/**
 * resultsShelf.ts
 *
 * The Results shelf: a `Results · N` control at the foot of the left rail (a
 * row at the top of the phone sheet's Layers tab) that opens a list of the
 * session's results, grouped by type, newest first. It reads
 * {@link ResultsIndex} and nothing else.
 *
 * Focus restores context and never recomputes. It moves the route to the page
 * that owns the result and aims the camera at the result's anchor, keeping the
 * current viewing distance. It never selects a different layer: a result from
 * another layer says so in its row and in the announcement, and the active
 * layer stays as it was.
 *
 * Every title comes from a file name or user metadata, so all text goes
 * through `textContent`.
 */

import {
  RESULT_TYPE_LABELS,
  RESULT_TYPE_ORDER,
  type ResultEntry,
  type ResultExportProduct,
  type ResultRoute,
  type ResultsIndex,
} from './resultsIndex';

export interface ResultsShelfDeps {
  readonly index: ResultsIndex;
  navigate(route: ResultRoute): void;
  /**
   * Aim the camera at a render-frame point. With `fit`, frame that radius;
   * without, keep the viewing distance.
   */
  aim(anchor: readonly [number, number, number], fit: number | null): void;
  /** Open the Export mode with `product` preselected. Returns false when it could not be marked. */
  exportTo(product: ResultExportProduct | undefined): boolean;
  /** The active layer id, or null. Read only; the shelf never sets it. */
  activeLayerId(): string | null;
  /** A display name for a layer id, or null when it is gone. */
  layerName(id: string): string | null;
  /** Clock for row times; injectable for tests. */
  now?: () => number;
}

export interface ResultsShelf {
  readonly element: HTMLElement;
  setExpanded(on: boolean): void;
  isExpanded(): boolean;
  focusResult(id: string): boolean;
  /** Re-render when the active layer changed, which moves the other-layer notes. */
  sync(): void;
  dispose(): void;
}


function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function clockTime(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const STATUS_LABEL: Readonly<Record<ResultEntry['status'], string>> = {
  ready: 'Ready',
  hidden: 'Hidden',
  stale: 'Out of date',
};

let shelfSeq = 0;

export function createResultsShelf(deps: ResultsShelfDeps): ResultsShelf {
  const listId = `olv-results-list-${++shelfSeq}`;
  const root = node('section', 'olv-results-shelf');
  root.setAttribute('aria-label', 'Results');
  const toggle = node('button', 'olv-results-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', listId);
  const toggleLabel = node('span', 'olv-results-toggle-label', 'Results');
  const toggleCount = node('span', 'olv-results-count', '0');
  toggle.append(toggleLabel, node('span', 'olv-results-sep', ' · '), toggleCount);
  const panel = node('div', 'olv-results-panel');
  panel.id = listId;
  panel.hidden = true;
  const live = node('p', 'olv-results-live');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  root.append(panel, toggle, live);

  let expanded = false;

  function otherSource(e: ResultEntry): string | null {
    const active = deps.activeLayerId();
    if (!e.sourceIdentity || !active || e.sourceIdentity === active) return null;
    return deps.layerName(e.sourceIdentity) ?? 'a closed layer';
  }

  function focusEntry(e: ResultEntry): void {
    deps.navigate(e.route);
    if (e.anchor) deps.aim(e.anchor, e.fit);
    const other = otherSource(e);
    live.textContent = other
      ? `Showing ${e.title} from ${other}. The active layer is unchanged.`
      : `Showing ${e.title}.`;
  }

  function row(e: ResultEntry): HTMLLIElement {
    const li = node('li', 'olv-results-row');
    li.dataset.resultId = e.id;
    li.dataset.resultType = e.type;
    const text = node('div', 'olv-results-text');
    text.append(node('span', 'olv-results-title', e.title));
    const meta = node('span', 'olv-results-meta');
    const parts = [clockTime(e.createdAt), STATUS_LABEL[e.status]];
    const other = otherSource(e);
    if (other) parts.push(`From ${other}`);
    meta.textContent = parts.join(' · ');
    if (other) li.classList.add('is-other-source');
    text.append(meta);
    const actions = node('div', 'olv-results-actions');
    const focus = node('button', 'olv-results-focus', 'Focus');
    focus.type = 'button';
    focus.setAttribute('aria-label', `Focus ${e.title}`);
    focus.addEventListener('click', () => focusEntry(e));
    actions.append(focus);
    if (e.exportProduct) {
      const product = e.exportProduct;
      const exp = node('button', 'olv-results-export', 'Export');
      exp.type = 'button';
      exp.setAttribute('aria-label', `Export ${e.title}`);
      exp.addEventListener('click', () => {
        const marked = deps.exportTo(product);
        live.textContent = marked
          ? `Export opened with ${e.title} selected.`
          : `Export opened. ${e.title} has no export here yet.`;
      });
      actions.append(exp);
    }
    li.append(text, actions);
    return li;
  }

  let renderedFor: string | null = null;
  function render(): void {
    renderedFor = deps.activeLayerId();
    const entries = deps.index.entries();
    toggleCount.textContent = String(entries.length);
    toggle.setAttribute('aria-label', `Results, ${entries.length}`);
    root.classList.toggle('is-empty', entries.length === 0);
    if (entries.length === 0 && expanded) setExpanded(false);
    const active = document.activeElement ?? null;
    const hadFocus = !!active && panel.contains(active);
    const focusedId = hadFocus ? (active.closest('[data-result-id]') as HTMLElement | null)?.dataset.resultId : undefined;
    panel.replaceChildren();
    for (const type of RESULT_TYPE_ORDER) {
      const group = entries.filter((e) => e.type === type);
      if (group.length === 0) continue;
      const headingId = `${listId}-${type}`;
      const h = node('h3', 'olv-results-group', RESULT_TYPE_LABELS[type]);
      h.id = headingId;
      const ul = node('ul', 'olv-results-list');
      ul.setAttribute('aria-labelledby', headingId);
      ul.append(...group.map(row));
      panel.append(h, ul);
    }
    if (hadFocus) {
      const back = focusedId ? panel.querySelector<HTMLElement>(`[data-result-id="${CSS.escape(focusedId)}"] .olv-results-focus`) : null;
      (back ?? toggle).focus({ preventScroll: true });
    }
  }

  function setExpanded(on: boolean): void {
    expanded = on && deps.index.entries().length > 0;
    toggle.setAttribute('aria-expanded', String(expanded));
    panel.hidden = !expanded;
    root.classList.toggle('is-open', expanded);
  }

  toggle.addEventListener('click', () => {
    setExpanded(!expanded);
    if (expanded) panel.querySelector<HTMLElement>('.olv-results-focus')?.focus({ preventScroll: true });
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && expanded) {
      ev.stopPropagation();
      setExpanded(false);
      toggle.focus({ preventScroll: true });
    }
  });

  const off = deps.index.subscribe(render);
  render();

  return {
    element: root,
    setExpanded,
    isExpanded: () => expanded,
    sync() { if (deps.activeLayerId() !== renderedFor) render(); },
    focusResult(id) {
      const e = deps.index.entries().find((x) => x.id === id);
      if (!e) return false;
      focusEntry(e);
      return true;
    },
    dispose: () => { off(); root.remove(); },
  };
}
