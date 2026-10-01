/**
 * sessionLogPage.ts
 *
 * The Session log page: a read-only table of the session's log, with Copy as
 * text and Export as JSON or CSV. With a scan open it is the Data page whose
 * header, location bar crumb, Back and Escape the router owns. With none open
 * it shows in a dialog, so the lines of a failed open can still be read.
 *
 * The page does no work while it is off screen. Once shown, a new entry adds
 * one row and the rows already on screen stay as they are.
 *
 * Every cell is set through `textContent`: the entries carry file and layer
 * names.
 */

import './sessionLog.css';
import type { SessionLog, SessionLogEntry } from './sessionLog';
import {
  clockTime,
  droppedNote,
  sessionLogCsv,
  sessionLogJson,
  sessionLogText,
  SESSION_LOG_KIND_LABEL,
} from './sessionLogFormat';
import { wireDialogA11y } from '../../ui/Modal';

export interface SessionLogPage {
  /** Rebuild the table from the log. */
  refresh(): void;
  /** Rebuild only if entries arrived while the page was off screen. */
  refreshIfDirty(): void;
  /** Stop following the log and empty the host. */
  dispose(): void;
}

export interface SessionLogPageOptions {
  readonly version?: string;
  readonly now?: () => number;
  /** Clipboard to copy into; null when the browser has none. Defaults to the browser's. */
  readonly clipboard?: Pick<Clipboard, 'writeText'> | null;
  /** How a repaint is deferred; one frame by default. */
  readonly schedule?: (fn: () => void) => void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = node('button', className, text);
  b.type = 'button';
  return b;
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The steps of `io/download.ts`, repeated so this chunk loads no other. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function defaultSchedule(fn: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
}

export function mountSessionLogPage(host: HTMLElement, log: SessionLog, opts: SessionLogPageOptions = {}): SessionLogPage {
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? defaultSchedule;
  host.replaceChildren();
  host.classList.add('olv-session-log');

  const intro = node('p', 'olv-sl-intro', 'What you did to the scans in this tab, and the result. The log lives in this tab\'s memory, and a reload clears it. It names a local file by its name alone, and a link by its host and file name.');
  const bar = node('div', 'olv-sl-actions');
  const copy = button('olv-sl-btn', 'Copy as text');
  const json = button('olv-sl-btn', 'Export JSON');
  const csv = button('olv-sl-btn', 'Export CSV');
  const order = button('olv-sl-btn olv-sl-order', 'Newest first');
  order.title = 'Reverse the order of the table';
  bar.append(copy, json, csv, order);

  const status = node('p', 'olv-sl-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const table = node('table', 'olv-sl-table');
  const caption = node('caption', 'olv-sl-caption');
  const head = node('thead', '');
  const hr = node('tr', '');
  const thTime = node('th', 'olv-sl-th-time', 'Time');
  thTime.scope = 'col';
  const thWhat = node('th', 'olv-sl-th-what', 'What');
  thWhat.scope = 'col';
  hr.append(thTime, thWhat);
  head.append(hr);
  const body = node('tbody', '');
  table.append(caption, head, body);
  const empty = node('p', 'olv-sl-empty', 'Nothing recorded yet. Opening a scan, measuring, running an analysis or exporting adds a line here.');
  const marker = node('tr', 'olv-sl-dropped');
  const markerCell = node('td', '');
  markerCell.colSpan = 2;
  marker.append(markerCell);

  host.append(intro, bar, status, table, empty);

  let newestFirst = true;
  /** Rows on screen, oldest first, beside the seq of the entry each shows. */
  let rows: Array<{ seq: number; tr: HTMLTableRowElement }> = [];
  let dirty = false;
  let queued = false;
  let disposed = false;

  function row(e: SessionLogEntry): HTMLTableRowElement {
    const tr = node('tr', `olv-sl-row is-${e.kind} is-${e.status}`);
    tr.dataset.kind = e.kind;
    const time = node('td', 'olv-sl-time');
    time.append(node('span', 'olv-sl-clock', clockTime(e.time)), node('span', 'olv-sl-kind', SESSION_LOG_KIND_LABEL[e.kind]));
    const what = node('td', 'olv-sl-what');
    what.append(node('span', 'olv-sl-text', e.text));
    const meta = [e.scan, e.detail, e.status === 'refused' || e.status === 'failed' ? e.status : null].filter(Boolean) as string[];
    if (meta.length) what.append(node('span', 'olv-sl-meta', meta.join(' · ')));
    tr.append(time, what);
    return tr;
  }

  /** Caption, buttons, empty note and the dropped row: everything but the entry rows. */
  function frame(): void {
    const count = log.entries().length;
    const dropped = log.dropped();
    caption.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}${dropped ? `, ${droppedNote(dropped)}` : ''}`;
    order.textContent = newestFirst ? 'Newest first' : 'Oldest first';
    thTime.setAttribute('aria-sort', newestFirst ? 'descending' : 'ascending');
    table.hidden = count === 0;
    empty.hidden = count > 0;
    for (const b of [copy, json, csv]) b.disabled = count === 0;
    if (dropped) {
      markerCell.textContent = droppedNote(dropped);
      if (newestFirst) body.append(marker);
      else body.insertBefore(marker, body.firstChild);
    } else {
      marker.remove();
    }
  }

  function render(): void {
    dirty = false;
    rows = log.entries().map((e) => ({ seq: e.seq, tr: row(e) }));
    const trs = rows.map((r) => r.tr);
    if (newestFirst) trs.reverse();
    body.replaceChildren(...trs);
    frame();
  }

  /** Add rows for entries newer than the last one shown; drop rows past the cap. */
  function update(): void {
    const list = log.entries();
    const first = list[0]?.seq ?? Infinity;
    while (rows.length && rows[0]!.seq < first) rows.shift()!.tr.remove();
    const last = rows.length ? rows[rows.length - 1]!.seq : 0;
    let i = list.length;
    while (i > 0 && list[i - 1]!.seq > last) i--;
    for (const e of list.slice(i)) {
      const tr = row(e);
      rows.push({ seq: e.seq, tr });
      if (newestFirst) body.insertBefore(tr, body.firstChild);
      else if (marker.parentElement === body) body.insertBefore(tr, null);
      else body.append(tr);
    }
    frame();
  }

  function visible(): boolean {
    return host.isConnected && !host.closest('.olv-ws-off') && !host.closest('.olv-hidden');
  }

  order.addEventListener('click', () => {
    newestFirst = !newestFirst;
    render();
  });
  copy.addEventListener('click', () => {
    const clip = opts.clipboard !== undefined ? opts.clipboard : (globalThis.navigator?.clipboard ?? null);
    if (!clip) {
      status.textContent = 'Copy is not available in this browser. Use Export instead.';
      return;
    }
    clip.writeText(sessionLogText(log)).then(
      () => { status.textContent = 'Session log copied as text.'; },
      () => { status.textContent = 'The browser refused the copy. Use Export instead.'; },
    );
  });
  json.addEventListener('click', () => {
    download(new Blob([sessionLogJson(log, opts.version ?? '')], { type: 'application/json' }), `session-log-${stamp(now())}.json`);
    status.textContent = 'Session log exported as JSON.';
  });
  csv.addEventListener('click', () => {
    download(new Blob([sessionLogCsv(log)], { type: 'text/csv' }), `session-log-${stamp(now())}.csv`);
    status.textContent = 'Session log exported as CSV.';
  });

  const off = log.subscribe(() => {
    if (queued || disposed) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (disposed) return;
      if (!visible()) dirty = true;
      else if (dirty) render();
      else update();
    });
  });
  render();

  return {
    refresh: render,
    refreshIfDirty() {
      if (dirty && visible()) render();
    },
    dispose() {
      disposed = true;
      off();
      host.replaceChildren();
    },
  };
}

let dialogSeq = 0;
/** The dialog on screen, if any: a second open focuses it instead. */
let openDialog: { close(): void; focus(): void } | null = null;

/** Where focus goes after the dialog: the opener while it is still on the page, else the app's first control. */
function focusAfter(opener: HTMLElement | null): void {
  const doc = document as Document;
  if (opener && opener !== doc.body && opener.isConnected) {
    opener.focus?.();
    return;
  }
  const app = doc.getElementById('app');
  const first = app ? Array.from(app.querySelectorAll<HTMLButtonElement>('button')).find((b) => !b.disabled && !b.hidden && !b.closest('.olv-hidden, [hidden]')) : undefined;
  first?.focus?.();
}

/**
 * The page in a dialog, for when no scan is open and the Data rail is hidden.
 * It joins the shared dialog stack, so Escape closes it, Tab stays inside it,
 * and the palette and shortcut keys wait until it closes. One opens at a
 * time; a second open focuses the first.
 */
export function openSessionLogDialog(log: SessionLog, opts: SessionLogPageOptions = {}): { close(): void } {
  if (openDialog) {
    openDialog.focus();
    return openDialog;
  }
  const opener = document.activeElement as HTMLElement | null;
  const titleId = `olv-session-log-title-${++dialogSeq}`;
  const title = node('h2', 'olv-modal-title', 'Session log');
  title.id = titleId;
  const close = button('olv-modal-x olv-sl-close', 'Close');
  close.setAttribute('aria-label', 'Close Session log');
  const host = node('section', '');
  const dialog = node('div', 'olv-modal olv-sl-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  const head = node('div', 'olv-modal-head');
  head.append(title, close);
  const bodyWrap = node('div', 'olv-modal-body');
  bodyWrap.append(host);
  dialog.append(head, bodyWrap);
  const backdrop = node('div', 'olv-modal-backdrop');
  backdrop.append(dialog);
  document.body.append(backdrop);
  const page = mountSessionLogPage(host, log, opts);

  let closed = false;
  const done = (): void => {
    if (closed) return;
    closed = true;
    if (openDialog === handle) openDialog = null;
    a11y.teardown();
    try {
      page.dispose();
    } finally {
      backdrop.remove();
      focusAfter(opener);
    }
  };
  const a11y = wireDialogA11y(dialog, { onEscape: done, returnFocusTo: opener });
  const handle = { close: done, focus: () => close.focus() };
  openDialog = handle;
  close.addEventListener('click', done);
  close.focus();
  return handle;
}
