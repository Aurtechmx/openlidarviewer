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

import './resultsWorkbench.css';
import { RELOAD_ADVICE } from '../../io/loadErrors';
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
  /**
   * Open a lab result (Flow Pulse, Terrain Access, Observatory) on its
   * Analyse page, showing the run it already holds. Returns false when it cannot, and the shelf then
   * navigates to the result's route instead.
   */
  openLabPage?(entry: ResultEntry): boolean;
  /** Open a profile measurement in the Profile Workbench. False when it cannot. */
  openWorkbench?(measurementId: string): boolean;
  /**
   * Open the export of one profile, by measurement id, until its dialog
   * closes. Rejects with a `ProfileExportRefusal` when it cannot be exported.
   */
  exportProfile?(measurementId: string): Promise<void>;
  /** Whether an open layer is hidden in the scene. */
  layerHidden?(id: string): boolean;
  /** Show a message on screen; the shelf's own status line is for screen readers. */
  notify?(message: string): void;
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

/** Products whose export holds every result of the type, not one of them. */
const COLLECTION: Readonly<Partial<Record<ResultExportProduct, string>>> = { measurements: 'measurements', findings: 'findings' };

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
    if (!deps.openLabPage?.(e)) deps.navigate(e.route);
    if (e.anchor) deps.aim(e.anchor, e.fit);
    const other = otherSource(e);
    live.textContent = other
      ? `Showing ${e.title} from ${other}. The active layer is unchanged.`
      : `Showing ${e.title}.`;
  }

  function say(message: string): void {
    live.textContent = message;
    deps.notify?.(message);
  }

  /** Why a result cannot be exported from here now, or null. */
  function refusal(e: ResultEntry): string | null {
    if (e.status === 'hidden') return `${e.title} is hidden. Show it, then export again.`;
    // A layer that was only active at the time does not own the result, so its closing withholds nothing.
    const inferred = e.sourceInferred === true;
    const src = e.sourceIdentity;
    const active = deps.activeLayerId();
    const name = src ? deps.layerName(src) : null;
    if (src && !inferred && src !== active && !name) return `${e.title} was not exported: the scan it was made on is closed. Reopen it, then export again.`;
    if (src && deps.layerHidden?.(src)) return `${e.title} was not exported: ${name ?? 'its scan'} is hidden. Show that scan, then export again.`;
    // The terrain products are of the active scan: never export its result under another's name.
    if (!e.workbench && src && active && src !== active) return `${e.title} was not exported: it is from ${name}. Make that scan active, then export again.`;
    return null;
  }

  function openExport(product: ResultExportProduct, name: string): void {
    live.textContent = deps.exportTo(product)
      ? `Export opened with ${name} selected.`
      : `Export opened. ${name[0]!.toUpperCase()}${name.slice(1)}: no export here yet.`;
  }

  // One profile export at a time: the promise lasts until its dialog closes.
  let exporting = false;
  async function exportOne(id: string, measurementId: string, btn: HTMLButtonElement, run: (id: string) => Promise<void>): Promise<void> {
    if (exporting) return;
    const title = deps.index.entries().find((x) => x.id === id)?.title ?? 'This result';
    deps.index.refresh();
    const e = deps.index.entries().find((x) => x.id === id);
    const why = e ? refusal(e) : `${title} is no longer available, so it was not exported.`;
    if (why || !e) { say(why!); return; }
    // The dialog gives focus back to the button that opened it.
    btn.focus({ preventScroll: true });
    live.textContent = `Opening the PDF export of ${e.title}.`;
    exporting = true;
    try {
      await run(measurementId);
    } catch (err) {
      if (err instanceof Error && err.name === 'ProfileExportRefusal') say(`${e.title}: ${err.message}`);
      else {
        // eslint-disable-next-line no-console
        console.error('OpenLiDARViewer: profile PDF export failed.', err);
        say(`The export of ${e.title} did not open. ${RELOAD_ADVICE}`);
      }
    } finally {
      exporting = false;
    }
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
    const openWorkbench = deps.openWorkbench;
    if (e.workbench && openWorkbench) {
      const id = e.workbench;
      const wb = node('button', 'olv-results-workbench', 'Workbench');
      wb.type = 'button';
      wb.setAttribute('aria-label', `Workbench: ${e.title}`);
      wb.title = `Open ${e.title} in the Profile Workbench`;
      wb.addEventListener('click', () => {
        live.textContent = openWorkbench(id)
          ? `Opening ${e.title} in the Profile Workbench.`
          : `${e.title} cannot open in the Profile Workbench: it has no chart. Its row on the Measure page says why.`;
      });
      actions.append(wb);
    }
    // A profile exports on its own. Other measurements and the findings export
    // together, from their heading: a row never names one and exports them all.
    const product = e.exportProduct;
    const { workbench, id } = e;
    const run = workbench ? deps.exportProfile : undefined;
    if (product && (run || !COLLECTION[product])) {
      const exp = node('button', 'olv-results-export', 'Export');
      exp.type = 'button';
      exp.setAttribute('aria-label', `Export ${e.title}${run ? ' as PDF' : ''}`);
      exp.addEventListener('click', () => {
        if (run) { void exportOne(id, workbench!, exp, run); return; }
        const why = refusal(e);
        if (why) say(why);
        else openExport(product, e.title);
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
      const product = group.find((e) => e.exportProduct)?.exportProduct;
      const all = product && COLLECTION[product];
      if (product && all) {
        const head = node('div', 'olv-results-head');
        const exp = node('button', 'olv-results-export olv-results-export-all', 'Export all');
        exp.type = 'button';
        exp.setAttribute('aria-label', `Export all ${all}`);
        exp.addEventListener('click', () => openExport(product, `all ${all}`));
        head.append(h, exp);
        panel.append(head, ul);
      } else panel.append(h, ul);
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
