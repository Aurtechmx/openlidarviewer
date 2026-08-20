/**
 * AnnotationPanel.ts
 *
 * The Annotations panel — a compact, sortable list of every placed annotation,
 * and the inspection view over the subset of them that are tracked issues.
 * A dumb view: the controller computes the summaries; the panel renders them,
 * sorts them, and reports intents (activate / edit / delete / clear / resolve)
 * back.
 *
 * Which annotations are issues, how they rank, and what the roll-up counts are
 * all decided by `render/annotate/issueWorkflow.ts`. The panel calls those
 * helpers on the very summaries it is about to render and never re-derives an
 * answer from `type === 'issue'` or from a severity comparison of its own, so
 * the list and the counts cannot drift apart from the model or from the saved
 * session.
 */

import { el } from './dom';
import type { AnnotationSummary } from '../render/annotate/AnnotationController';
import type { AnnotationType } from '../render/annotate/types';
import { describeAnnotationGroups, groupByCategory } from '../render/annotate/annotationClustering';
import type {
  IssueDetails,
  IssueSeverity,
  IssueStatus,
  IssueSummary,
} from '../render/annotate/issueWorkflow';
import {
  ISSUE_SEVERITIES,
  filterIssuesByStatus,
  sortIssuesBySeverity,
  summarizeIssues,
} from '../render/annotate/issueWorkflow';
import { SEVERITY_GLYPH, severityAriaLabel, severityText } from './issueSeverityStyle';
import { announcePolite } from './politeAnnounce';

/** How the annotation list is ordered. */
export type AnnotationSort = 'created' | 'updated' | 'type' | 'title';

/** Which roster the list is showing: everything, or the tracked issues. */
type PanelView = 'all' | 'issues';

/** A summary that carries the workflow block — one row of the issue list. */
type IssueRow = AnnotationSummary & { issue: IssueDetails };

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
  /** Move a tracked issue between open and resolved. */
  onSetIssueStatus: (id: string, status: IssueStatus) => void;
}

const SORT_OPTIONS: { value: AnnotationSort; label: string }[] = [
  { value: 'created', label: 'Created' },
  { value: 'updated', label: 'Recently edited' },
  { value: 'type', label: 'Type' },
  { value: 'title', label: 'Title' },
];

/** Type order for the "Type" sort — most actionable first. */
const TYPE_RANK: Record<AnnotationType, number> = { issue: 0, warning: 1, info: 2, note: 3 };

/** Capitalised section labels for the grouped (long) list. */
const CATEGORY_LABEL: Record<AnnotationType, string> = {
  issue: 'Issues',
  warning: 'Warnings',
  info: 'Info',
  note: 'Notes',
};

/** Above this many rows the list splits into per-category sections. */
const GROUP_THRESHOLD = 8;

/**
 * What "resolved" is worth, said once and shown wherever the word appears. The
 * viewer stores a status somebody set; it has no way to check that the
 * condition was fixed, and nothing here may suggest otherwise.
 */
const RESOLVED_TIP =
  'Marked resolved by hand. The viewer records the status; it does not verify that anything was fixed.';

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
  private readonly _sortSelect: HTMLSelectElement;
  /** The All / Issues switch and its two buttons. */
  private readonly _views: HTMLElement;
  private readonly _viewBtns = new Map<PanelView, HTMLButtonElement>();
  /** The issue roll-up strip — open counts, worst open rank, resolved tail. */
  private readonly _issues: HTMLElement;
  private _summaries: AnnotationSummary[] = [];
  private _sort: AnnotationSort = 'created';
  private _view: PanelView = 'all';
  /** Whether the resolved issues are expanded under the open ones. */
  private _showResolved = false;
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

    // All / Issues switch. Hidden until something is actually tracked, so a
    // survey with no findings keeps the panel it had.
    this._views = el('div', { className: 'olv-ap-views olv-hidden' });
    this._views.setAttribute('role', 'group');
    this._views.setAttribute('aria-label', 'Annotation list view');
    for (const view of ['all', 'issues'] as const) {
      const btn = el('button', {
        className: 'olv-ap-view',
        text: view === 'all' ? 'All' : 'Issues',
        title: view === 'all' ? 'Show every annotation' : 'Show the tracked issues',
      });
      btn.type = 'button';
      btn.addEventListener('click', () => {
        btn.blur();
        this._view = view;
        this._render();
      });
      this._viewBtns.set(view, btn);
      this._views.append(btn);
    }

    this._issues = el('div', { className: 'olv-ap-issues olv-hidden' });

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
    this._sortSelect = sortSelect;

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
      this._views,
      this._issues,
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
    // The roll-up counts the WHOLE roster, not the search result: a query that
    // happens to hide the critical findings must not report them as gone.
    const issues = summarizeIssues(this._summaries);
    this._renderRollup(issues);
    // Nothing tracked means no issue view to be in, and the switch has nothing
    // to offer. Set the field directly — `_render` is already running.
    if (issues.total === 0) this._view = 'all';
    this._views.classList.toggle('olv-hidden', issues.total === 0);
    for (const [view, btn] of this._viewBtns) {
      const on = view === this._view;
      btn.classList.toggle('olv-ap-view-active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    // The issue view is ranked by the model, so the sort control has no say in
    // it. Disabled rather than ignored: a control that quietly does nothing is
    // worse than one that says it does not apply here.
    this._sortSelect.disabled = this._view === 'issues';
    this._sortSelect.title =
      this._view === 'issues'
        ? 'Issues are ranked by severity, worst first'
        : 'Sort the annotation list';
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
    if (this._view === 'issues') {
      this._renderIssues(filtered);
      return;
    }
    const sorted = sortSummaries(filtered, this._sort);
    // A short list reads fine flat; a long one splits into per-category sections
    // (severity-first) so a dense roster is navigable instead of a wall of rows.
    // Search + sort still apply — grouping partitions the already-filtered,
    // already-sorted list and keeps each row's order within its section.
    if (sorted.length > GROUP_THRESHOLD) {
      const groups = [...groupByCategory(sorted)].sort(
        (x, y) => TYPE_RANK[x.type] - TYPE_RANK[y.type],
      );
      const nodes: HTMLElement[] = [];
      for (const g of groups) {
        nodes.push(this._groupHeader(g.type, g.items.length));
        for (const s of g.items) nodes.push(this._row(s));
      }
      this._list.replaceChildren(...nodes);
    } else {
      this._list.replaceChildren(...sorted.map((s) => this._row(s)));
    }
  }

  /**
   * The issue view: the open issues worst first, then the resolved ones behind
   * a disclosure so they are reachable without competing with live work.
   */
  private _renderIssues(list: AnnotationSummary[]): void {
    const open = this._issueRows(list, 'open');
    const resolved = this._issueRows(list, 'resolved');
    const nodes: HTMLElement[] = [];
    if (open.length === 0) {
      nodes.push(
        el('div', {
          className: 'olv-ap-empty',
          text: this._query
            ? 'No issues match your search.'
            : resolved.length > 0
              ? 'Nothing open here. Every issue below is marked resolved.'
              : 'No issues tracked yet.',
        }),
      );
    }
    // The list arrives ranked worst first, so each severity's rows are already
    // adjacent: walking the runs labels the ranking rather than re-deriving it.
    let i = 0;
    while (i < open.length) {
      const severity = open[i].issue.severity;
      let end = i;
      while (end < open.length && open[end].issue.severity === severity) end += 1;
      nodes.push(this._severityHeader(severity, end - i));
      for (; i < end; i++) nodes.push(this._row(open[i]));
    }
    if (resolved.length > 0) {
      nodes.push(this._resolvedToggle(resolved.length));
      if (this._showResolved) for (const row of resolved) nodes.push(this._row(row));
    }
    this._list.replaceChildren(...nodes);
  }

  /**
   * The rows of one status, ranked worst first.
   *
   * Membership comes from `filterIssuesByStatus` and the order from
   * `sortIssuesBySeverity`; this method only pairs the model's answer back up
   * with the panel-side fields (marker index, selection) by id. A summary
   * carries every field those helpers read — the id, the timestamps and the
   * workflow block — so they rank the rows being rendered rather than a
   * parallel copy that could disagree with them.
   */
  private _issueRows(list: AnnotationSummary[], status: IssueStatus): IssueRow[] {
    const byId = new Map(list.map((s) => [s.id, s]));
    const rows: IssueRow[] = [];
    for (const ranked of sortIssuesBySeverity(filterIssuesByStatus(list, status))) {
      const row = byId.get(ranked.id);
      if (row === undefined || row.issue === undefined) continue;
      rows.push({ ...row, issue: row.issue });
    }
    return rows;
  }

  /** A severity section header — bar, word and the count under it. */
  private _severityHeader(severity: IssueSeverity, count: number): HTMLElement {
    return el('div', { className: `olv-ap-group olv-ap-sev-${severity}` }, [
      el('span', { className: 'olv-ap-group-label', text: severityText(severity) }),
      el('span', { className: 'olv-ap-group-count', text: String(count) }),
    ]);
  }

  /** The disclosure that keeps resolved issues reachable but out of the way. */
  private _resolvedToggle(count: number): HTMLElement {
    const btn = el('button', {
      className: 'olv-ap-resolved-toggle',
      text: `${this._showResolved ? '▾' : '▸'} Marked resolved (${count})`,
      title: RESOLVED_TIP,
    });
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(this._showResolved));
    btn.addEventListener('click', () => {
      btn.blur();
      this._showResolved = !this._showResolved;
      this._render();
    });
    return btn;
  }

  /**
   * The roll-up strip: how much is open, at what worst rank, and how much has
   * been marked resolved.
   *
   * Everything here is a count of what is OPEN. `highestOpenSeverity` is absent
   * when nothing is open, and that case prints the zero count and no rank at
   * all — "nothing outstanding" and "the worst outstanding thing is minor" are
   * different reports. The resolved tail says "marked resolved"
   * because that is all the viewer knows: a person set a status, and no check
   * was run against the scan.
   */
  private _renderRollup(summary: IssueSummary): void {
    this._issues.classList.toggle('olv-hidden', summary.total === 0);
    if (summary.total === 0) {
      this._issues.replaceChildren();
      return;
    }
    const parts: HTMLElement[] = [
      el('span', {
        className: 'olv-ap-issues-open',
        text: summary.open === 1 ? '1 open issue' : `${summary.open} open issues`,
      }),
    ];
    if (summary.highestOpenSeverity !== undefined) {
      parts.push(
        el('span', {
          className: `olv-ap-issues-worst olv-ap-sev-${summary.highestOpenSeverity}`,
          text: `worst open ${severityText(summary.highestOpenSeverity)}`,
        }),
      );
    }
    // Worst first, so the strip reads in the same order as the list below it.
    for (const severity of [...ISSUE_SEVERITIES].reverse()) {
      const count = summary.openBySeverity[severity];
      if (count === 0) continue;
      parts.push(
        el('span', {
          className: `olv-ap-issues-chip olv-ap-sev-${severity}`,
          text: `${severityText(severity)} ${count}`,
          ariaLabel: `${count} open at ${severity} severity`,
        }),
      );
    }
    if (summary.resolved > 0) {
      parts.push(
        el('span', {
          className: 'olv-ap-issues-resolved',
          text: `${summary.resolved} marked resolved`,
          title: RESOLVED_TIP,
        }),
      );
    }
    this._issues.replaceChildren(...parts);
  }

  /** A category section header for the grouped (long) list. */
  private _groupHeader(type: AnnotationType, count: number): HTMLElement {
    return el('div', { className: `olv-ap-group olv-anno-${type}` }, [
      el('span', { className: 'olv-ap-group-label', text: CATEGORY_LABEL[type] }),
      el('span', { className: 'olv-ap-group-count', text: String(count) }),
    ]);
  }

  /** Whether a summary matches the current search query (title / note / type). */
  private _matches(s: AnnotationSummary): boolean {
    const q = this._query;
    return (
      s.title.toLowerCase().includes(q) ||
      s.note.toLowerCase().includes(q) ||
      s.type.includes(q) ||
      // Both workflow words are searchable: "critical" and "resolved" are how
      // an inspector describes a finding out loud.
      (s.issue !== undefined && (s.issue.severity.includes(q) || s.issue.status.includes(q)))
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
    // A tracked issue carries its rank as a bar. The row is too narrow for the
    // word, so the accessible name and the tooltip carry it instead; the bar
    // still orders the ranks on its own, without colour.
    if (s.issue) {
      cells.push(
        el('span', {
          className: `olv-ap-sev-mark olv-ap-sev-${s.issue.severity}`,
          text: SEVERITY_GLYPH[s.issue.severity],
          title: severityAriaLabel(s.issue.severity),
          ariaLabel: severityAriaLabel(s.issue.severity),
        }),
      );
    }
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
    cells.push(time);
    if (s.issue) cells.push(this._statusButton(s.id, s.title, s.issue.status));
    cells.push(edit, del);

    const row = el('div', { className: 'olv-ap-row' }, cells);
    if (s.selected) row.classList.add('olv-ap-row-selected');
    // Hovering a row highlights its marker in the scene, and vice-versa.
    row.addEventListener('mouseenter', () => this._cb.onHover(s.id));
    row.addEventListener('mouseleave', () => this._cb.onHover(null));
    return row;
  }

  /**
   * The resolve / reopen control on an issue row. One click each way: the
   * status is the only thing it writes, and the write goes to the controller,
   * which routes it through the model's `setIssueStatus`.
   *
   * The click rebuilds the list and the row under the pointer goes with it, so
   * the outcome is announced rather than left to be inferred from a button that
   * no longer exists.
   */
  private _statusButton(id: string, title: string, status: IssueStatus): HTMLButtonElement {
    const open = status === 'open';
    const next: IssueStatus = open ? 'resolved' : 'open';
    const btn = el('button', {
      className: `olv-ap-issue-status olv-ap-issue-${status}`,
      text: open ? 'Resolve' : 'Reopen',
      title: open ? `Mark ${title} resolved. ${RESOLVED_TIP}` : `Reopen ${title}`,
      ariaLabel: open ? `Mark ${title} resolved` : `Reopen ${title}`,
    });
    btn.type = 'button';
    btn.addEventListener('click', () => {
      btn.blur();
      this._cb.onSetIssueStatus(id, next);
      announcePolite(open ? `${title} marked resolved.` : `${title} reopened.`);
    });
    return btn;
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
