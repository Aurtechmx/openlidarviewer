/**
 * sessionLogPage.ts
 *
 * The Session log page under Data: a read-only table of the session's log,
 * with Copy as text and Export as JSON or CSV. It ships in the workspace
 * shell's chunk and builds its DOM on first open. The router owns the page
 * header, the location bar crumb, Back and Escape.
 *
 * Every cell is set through `textContent`: the entries carry file and layer
 * names.
 *
 * The download repeats the steps of `io/download.ts`: importing that module
 * here would add its chunk to the shell's preload list in the startup bundle.
 */

import type { SessionLog, SessionLogEntry } from './sessionLog';
import {
  clockTime,
  droppedNote,
  sessionLogCsv,
  sessionLogJson,
  sessionLogText,
  SESSION_LOG_KIND_LABEL,
} from './sessionLogFormat';

export interface SessionLogPage {
  /** Re-read the log; the page also follows it while mounted. */
  refresh(): void;
  dispose(): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

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

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function mountSessionLogPage(
  host: HTMLElement,
  log: SessionLog,
  opts: { version?: string; now?: () => number; clipboard?: Pick<Clipboard, 'writeText'> | null } = {},
): SessionLogPage {
  const now = opts.now ?? (() => Date.now());
  host.replaceChildren();
  host.classList.add('olv-session-log');

  const intro = node('p', 'olv-sl-intro', 'What you did to the scans in this tab, and the result. The log lives in this tab\'s memory, and a reload clears it. It names each file by its base name.');
  const bar = node('div', 'olv-sl-actions');
  const copy = node('button', 'olv-sl-btn', 'Copy as text');
  copy.type = 'button';
  const json = node('button', 'olv-sl-btn', 'Export JSON');
  json.type = 'button';
  json.setAttribute('aria-label', 'Export the session log as JSON');
  const csv = node('button', 'olv-sl-btn', 'Export CSV');
  csv.type = 'button';
  csv.setAttribute('aria-label', 'Export the session log as CSV');
  const order = node('button', 'olv-sl-btn olv-sl-order');
  order.type = 'button';
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

  host.append(intro, bar, status, table, empty);

  let newestFirst = true;

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

  function render(): void {
    const list = log.entries();
    const dropped = log.dropped();
    caption.textContent = `${list.length} ${list.length === 1 ? 'entry' : 'entries'}${dropped ? `, ${droppedNote(dropped)}` : ''}`;
    order.textContent = newestFirst ? 'Newest first' : 'Oldest first';
    order.setAttribute('aria-label', `Order: ${newestFirst ? 'newest first' : 'oldest first'}. Activate to reverse.`);
    thTime.setAttribute('aria-sort', newestFirst ? 'descending' : 'ascending');
    const rows = list.map(row);
    if (newestFirst) rows.reverse();
    const marker = dropped
      ? (() => {
        const tr = node('tr', 'olv-sl-row olv-sl-dropped');
        const td = node('td', '', droppedNote(dropped));
        td.colSpan = 2;
        tr.append(td);
        return tr;
      })()
      : null;
    body.replaceChildren(...(marker && !newestFirst ? [marker] : []), ...rows, ...(marker && newestFirst ? [marker] : []));
    table.hidden = list.length === 0;
    empty.hidden = list.length > 0;
    for (const b of [copy, json, csv]) b.disabled = list.length === 0;
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

  // Follow the log while mounted, one repaint per frame at most.
  let queued = false;
  const off = log.subscribe(() => {
    if (queued) return;
    queued = true;
    const later = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 16);
    later(() => { queued = false; render(); });
  });
  render();

  return {
    refresh: render,
    dispose() {
      off();
      host.replaceChildren();
    },
  };
}
