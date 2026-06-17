/**
 * AnnotationPanel.ts
 *
 * The Annotations panel — a compact, sortable list of every placed annotation.
 * A dumb view: the controller computes the summaries; the panel renders them,
 * sorts them, and reports intents (activate / edit / delete / clear) back.
 */

import { el } from './dom';
import type { AnnotationSummary } from '../render/annotate/AnnotationController';
import type { AnnotationType } from '../render/annotate/types';
import { describeAnnotationGroups } from '../render/annotate/annotationClustering';

/** How the annotation list is ordered. */
export type AnnotationSort = 'created' | 'updated' | 'type' | 'title';

/** Hooks the panel calls back into. */
export interface AnnotationPanelCallbacks {
  /** Select the annotation and move the camera to it. */
  onActivate: (id: string) => void;
  /** Open the editor for this annotation, anchored near a screen point. */
  onEdit: (id: string, x: number, y: number) => void;
  /** Delete the annotation with this id. */
  onDelete: (id: string) => void;
  /** Delete every annotation. */
  onClearAll: () => void;
  /** Highlight the matching marker while a row is hovered (`null` clears it). */
  onHover: (id: string | null) => void;
}

const SORT_OPTIONS: { value: AnnotationSort; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Recently edited' },
  { value: 'type', label: 'Type' },
  { value: 'title', label: 'Title' },
];

/** Type order for the "Type" sort — most actionable first. */
const TYPE_RANK: Record<AnnotationType, number> = { issue: 0, warning: 1, info: 2, note: 3 };

/** A short relative time, e.g. "just now", "4m ago", "2h ago", "3d ago". */
function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.floor(Math.max(0, now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Sort a copy of the summaries by the chosen mode. */
function sortSummaries(list: AnnotationSummary[], mode: AnnotationSort): AnnotationSummary[] {
  const out = list.slice();
  if (mode === 'created') out.sort((a, b) => a.createdAt - b.createdAt);
  else if (mode === 'updated') out.sort((a, b) => b.updatedAt - a.updatedAt);
  else if (mode === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
  else out.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.createdAt - b.createdAt);
  return out;
}

export class AnnotationPanel {
  /** The panel element — append to the stage overlay. */
  readonly element: HTMLElement;

  private readonly _cb: AnnotationPanelCallbacks;
  private readonly _list: HTMLElement;
  private readonly _summary: HTMLElement;
  private readonly _clearBtn: HTMLButtonElement;
  private readonly _search: HTMLInputElement;
  private _summaries: AnnotationSummary[] = [];
  private _sort: AnnotationSort = 'created';
  /** The lower-cased search query; empty means "show everything". */
  private _query = '';
  private _clearArmed = false;
  private _clearTimer: number | undefined;

  constructor(callbacks: AnnotationPanelCallbacks) {
    this._cb = callbacks;
    this._list = el('div', { className: 'olv-ap-list' });
    // Compact grouping summary: total · category breakdown · areas. A status
    // region so a screen reader hears the count change as annotations are added.
    this._summary = el('div', { className: 'olv-ap-summary olv-hidden' });
    this._summary.setAttribute('role', 'status');
    this._summary.setAttribute('aria-live', 'polite');

    this._search = el('input', {
      className: 'olv-ap-search',
      type: 'text',
      title: 'Filter annotations by title, note or type',
    });
    this._search.placeholder = 'Search annotations…';
    this._search.addEventListener('input', () => {
      this._query = this._search.value.trim().toLowerCase();
      this._render();
    });

    const sortSelect = el('select', {
      className: 'olv-ap-sort',
      title: 'Sort the annotation list',
    });
    for (const opt of SORT_OPTIONS) {
      const o = el('option', { text: opt.label });
      o.value = opt.value;
      sortSelect.append(o);
    }
    sortSelect.addEventListener('change', () => {
      this._sort = sortSelect.value as AnnotationSort;
      this._render();
    });

    this._clearBtn = el('button', {
      className: 'olv-ap-action',
      text: 'Clear all',
      title: 'Delete every annotation',
    });
    this._clearBtn.addEventListener('click', () => this._handleClear());

    // v0.3.6 mobile collapse — chevron toggle inside the existing head.
    // Sort select still lives in the head row so it stays reachable when
    // the panel is expanded; collapse toggle is rightmost.
    const collapseBtn = el('button', {
      className: 'olv-collapse-toggle',
      type: 'button',
      ariaLabel: 'Collapse panel',
      title: 'Collapse this panel',
    });
    collapseBtn.append(el('span', { className: 'olv-chevron', text: '▾' }));
    const title = el('span', { className: 'olv-ap-title', text: 'Annotations' });
    const head = el('div', { className: 'olv-ap-head olv-panel-head' }, [
      title,
      sortSelect,
      collapseBtn,
    ]);
    const toggleCollapsed = () => {
      this.element.classList.toggle('olv-collapsed');
    };
    collapseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapsed();
    });
    head.addEventListener('click', (e) => {
      // Tap the title to toggle; sort select keeps its own click semantics.
      if (e.target === title) toggleCollapsed();
    });
    this.element = el('aside', { className: 'olv-anno-panel olv-hidden' }, [
      head,
      this._search,
      this._summary,
      this._list,
      el('div', { className: 'olv-ap-footer' }, [this._clearBtn]),
    ]);
  }

  /** Show or hide the panel. */
  setVisible(visible: boolean): void {
    this.element.classList.toggle('olv-hidden', !visible);
  }

  /** Rebuild the list from the controller's summaries. */
  update(summaries: AnnotationSummary[]): void {
    this._summaries = summaries;
    this._render();
  }

  private _render(): void {
    const total = this._summaries.length;
    this._clearBtn.disabled = total === 0;
    // The search box is only meaningful once there is something to filter.
    this._search.classList.toggle('olv-hidden', total === 0);
    // Grouping summary — shown only once there is a roster to summarise.
    const summaryText = describeAnnotationGroups(this._summaries);
    this._summary.textContent = summaryText;
    this._summary.classList.toggle('olv-hidden', summaryText === '');
    if (total === 0) {
      this._disarmClear();
      this._list.replaceChildren(
        el('div', { className: 'olv-ap-empty', text: 'No annotations yet.' }),
      );
      return;
    }
    const filtered = this._query
      ? this._summaries.filter((s) => this._matches(s))
      : this._summaries;
    if (filtered.length === 0) {
      this._list.replaceChildren(
        el('div', { className: 'olv-ap-empty', text: 'No annotations match your search.' }),
      );
      return;
    }
    const sorted = sortSummaries(filtered, this._sort);
    this._list.replaceChildren(...sorted.map((s) => this._row(s)));
  }

  /** Whether a summary matches the current search query (title / note / type). */
  private _matches(s: AnnotationSummary): boolean {
    const q = this._query;
    return (
      s.title.toLowerCase().includes(q) ||
      s.note.toLowerCase().includes(q) ||
      s.type.includes(q)
    );
  }

  private _row(s: AnnotationSummary): HTMLElement {
    const badge = el('span', {
      className: `olv-ap-badge olv-anno-${s.type}`,
      text: String(s.index),
    });

    const title = el('button', {
      className: 'olv-ap-name',
      text: s.title,
      title: s.note ? s.note : 'Jump to this annotation',
    });
    title.addEventListener('click', () => this._cb.onActivate(s.id));

    const time = el('span', { className: 'olv-ap-time', text: relativeTime(s.updatedAt) });

    const edit = el('button', {
      className: 'olv-ap-edit',
      text: 'Edit',
      title: `Edit ${s.title}`,
      ariaLabel: `Edit ${s.title}`,
    });
    edit.addEventListener('click', (e) => this._cb.onEdit(s.id, e.clientX, e.clientY));

    const del = el('button', {
      className: 'olv-ap-del',
      text: '×',
      title: `Delete ${s.title}`,
      ariaLabel: `Delete ${s.title}`,
    });
    del.addEventListener('click', () => this._cb.onDelete(s.id));

    const cells: HTMLElement[] = [badge, title];
    // A linked measurement shows as a low-emphasis chip after the title.
    if (s.linkedMeasurement) {
      cells.push(
        el('span', {
          className: 'olv-ap-link',
          text: s.linkedMeasurement,
          title: `Linked to measurement "${s.linkedMeasurement}"`,
        }),
      );
    }
    cells.push(time, edit, del);

    const row = el('div', { className: 'olv-ap-row' }, cells);
    if (s.selected) row.classList.add('olv-ap-row-selected');
    // Hovering a row highlights its marker in the scene, and vice-versa.
    row.addEventListener('mouseenter', () => this._cb.onHover(s.id));
    row.addEventListener('mouseleave', () => this._cb.onHover(null));
    return row;
  }

  /** Two-click confirmation for clear-all. */
  private _handleClear(): void {
    this._clearBtn.blur();
    if (this._clearArmed) {
      this._disarmClear();
      this._cb.onClearAll();
      return;
    }
    this._clearArmed = true;
    this._clearBtn.textContent = 'Confirm — clear all?';
    this._clearBtn.classList.add('olv-ap-action-armed');
    this._clearTimer = window.setTimeout(() => this._disarmClear(), 3500);
  }

  private _disarmClear(): void {
    if (this._clearTimer !== undefined) window.clearTimeout(this._clearTimer);
    this._clearTimer = undefined;
    this._clearArmed = false;
    this._clearBtn.textContent = 'Clear all';
    this._clearBtn.classList.remove('olv-ap-action-armed');
  }
}
