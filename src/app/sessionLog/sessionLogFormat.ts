/**
 * sessionLogFormat.ts
 *
 * The Session log as text, CSV and JSON, and the labels its page shows. Only
 * the page imports this, so it loads with the page.
 */

import type { SessionLog, SessionLogKind } from './sessionLog';

export const SESSION_LOG_KIND_LABEL: Readonly<Record<SessionLogKind, string>> = {
  scan: 'Scan',
  crs: 'CRS',
  analysis: 'Analysis',
  measurement: 'Measurement',
  annotation: 'Annotation',
  filter: 'Filter',
  export: 'Export',
  command: 'Command',
  message: 'Message',
  error: 'Error',
};


// ── text, CSV and JSON ──────────────────────────────────────────────────────

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Local wall-clock time, HH:MM:SS. */
export function clockTime(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function droppedNote(n: number): string {
  return `${n} older ${n === 1 ? 'entry' : 'entries'} dropped`;
}

export function sessionLogText(log: Pick<SessionLog, 'entries' | 'dropped'>): string {
  const lines: string[] = [];
  if (log.dropped() > 0) lines.push(`(${droppedNote(log.dropped())})`);
  for (const e of log.entries()) {
    const parts = [clockTime(e.time), SESSION_LOG_KIND_LABEL[e.kind]];
    if (e.scan) parts.push(e.scan);
    let line = `${parts.join('  ')}  ${e.text}`;
    if (e.detail) line += ` (${e.detail})`;
    if (e.status !== 'done' && e.status !== 'info') line += ` [${e.status}]`;
    lines.push(line);
  }
  return lines.join('\n');
}

function csvCell(v: string): string {
  // A leading formula character is neutralised so a spreadsheet never runs it.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function sessionLogCsv(log: Pick<SessionLog, 'entries' | 'dropped'>): string {
  const rows = [['seq', 'time', 'kind', 'status', 'scan', 'text', 'detail']];
  if (log.dropped() > 0) rows.push(['', '', 'note', 'info', '', droppedNote(log.dropped()), '']);
  for (const e of log.entries()) {
    rows.push([String(e.seq), new Date(e.time).toISOString(), e.kind, e.status, e.scan ?? '', e.text, e.detail ?? '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function sessionLogJson(log: Pick<SessionLog, 'entries' | 'dropped'>, version: string): string {
  return JSON.stringify(
    {
      kind: 'openlidarviewer.session-log',
      schemaVersion: 1,
      appVersion: version,
      droppedOlderEntries: log.dropped(),
      entries: log.entries().map((e) => ({
        seq: e.seq,
        time: new Date(e.time).toISOString(),
        kind: e.kind,
        status: e.status,
        scan: e.scan,
        text: e.text,
        detail: e.detail,
      })),
    },
    null,
    2,
  );
}
