/**
 * sessionLog.ts
 *
 * The Session log: an append-only, in-memory list of what was done to the
 * scans in this browser tab and what came of it. Nothing here is persisted or
 * sent anywhere; reloading the page starts an empty log.
 *
 * The store holds display text only. Every text that could carry a file
 * location goes through {@link redactPaths} on the way in, so a log copied
 * into a bug report names files by their base name and never by a folder or a
 * full link.
 *
 * The log keeps the newest {@link SESSION_LOG_CAP} entries. Older ones are
 * dropped and counted, and every view and export says how many were dropped.
 *
 * The palette reaches the log through two document events, so the action
 * registry's chunk does not carry it: `olv-session-log` appends an entry and
 * `olv-session-log-open` asks the workspace shell to open the page.
 */

/** Appends `detail` (a {@link SessionLogInput}) to the log. */
export const SESSION_LOG_EVENT = 'olv-session-log';
/** Opens the page; `detail.respond` receives a promise of whether it opened. */
export const SESSION_LOG_OPEN_EVENT = 'olv-session-log-open';

export type SessionLogKind =
  | 'scan'
  | 'crs'
  | 'analysis'
  | 'measurement'
  | 'annotation'
  | 'filter'
  | 'export'
  | 'command'
  | 'message'
  | 'error';

export type SessionLogStatus = 'done' | 'removed' | 'refused' | 'failed' | 'info';

export interface SessionLogInput {
  readonly kind: SessionLogKind;
  readonly text: string;
  readonly status?: SessionLogStatus;
  /** The scan the action applied to, by name. Null when none was open. */
  readonly scan?: string | null;
  /** Method, file type or other short qualifier. */
  readonly detail?: string;
}

export interface SessionLogEntry {
  /** 1-based position in the session, counting dropped entries. */
  readonly seq: number;
  /** Epoch milliseconds. */
  readonly time: number;
  readonly kind: SessionLogKind;
  readonly text: string;
  readonly status: SessionLogStatus;
  readonly scan: string | null;
  readonly detail: string | null;
}

export interface SessionLog {
  append(input: SessionLogInput): SessionLogEntry | null;
  /** Oldest first. */
  entries(): readonly SessionLogEntry[];
  /** How many older entries were dropped to stay within the cap. */
  dropped(): number;
  subscribe(fn: () => void): () => void;
  /** Where an entry with no `scan` of its own reads the active scan's name. */
  setScanSource(fn: (() => string | null) | null): void;
}

export const SESSION_LOG_CAP = 2000;
/** Longest text kept per entry, so one runaway message cannot fill the log. */
const MAX_TEXT = 400;

/** The last segment of a path or link, without query or fragment. */
export function baseName(value: string): string {
  const noQuery = value.split(/[?#]/)[0] ?? '';
  const parts = noQuery.split(/[\\/]/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// A link (any scheme), a home-relative path, a POSIX path with at least two
// segments, or a Windows drive or UNC path. Group 1 is the character before a
// POSIX path, which is kept.
const PATH_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+|~\/[^\s"'<>)]+|(^|[\s("'=])(\/[^\s"'<>)/]+\/[^\s"'<>)]+)|\b[A-Za-z]:\\[^\s"'<>)]+|\\\\[^\s"'<>)]+/gi;

/** Replace every path or link in `text` with its base name. */
export function redactPaths(text: string): string {
  return text.replace(PATH_PATTERN, (m: string, lead?: string, posix?: string) =>
    posix ? `${lead ?? ''}${baseName(posix) || '(path)'}` : baseName(m) || '(link)');
}

function clean(text: string): string {
  const one = redactPaths(text).replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}

function safeScan(fn: (() => string | null) | null): string | null {
  try {
    return fn ? fn() : null;
  } catch {
    return null;
  }
}

function scanOf(name: string | null): string | null {
  return name ? clean(baseName(name) || name) : null;
}

export function createSessionLog(opts: { cap?: number; now?: () => number } = {}): SessionLog {
  const cap = Math.max(1, opts.cap ?? SESSION_LOG_CAP);
  const now = opts.now ?? (() => Date.now());
  let list: SessionLogEntry[] = [];
  let seq = 0;
  let droppedCount = 0;
  const subs = new Set<() => void>();
  let scanSource: (() => string | null) | null = null;
  return {
    append(input) {
      const text = clean(input.text);
      if (!text) return null;
      const entry: SessionLogEntry = {
        seq: ++seq,
        time: now(),
        kind: input.kind,
        text,
        status: input.status ?? 'done',
        scan: scanOf(input.scan === undefined ? safeScan(scanSource) : input.scan),
        detail: input.detail ? clean(input.detail) : null,
      };
      list.push(entry);
      if (list.length > cap) {
        const over = list.length - cap;
        list = list.slice(over);
        droppedCount += over;
      }
      for (const fn of subs) {
        try {
          fn();
        } catch {
          /* a broken view must not stop the log */
        }
      }
      return entry;
    },
    entries: () => list,
    dropped: () => droppedCount,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    setScanSource(fn) {
      scanSource = fn;
    },
  };
}

/** The tab's one log. */
export const sessionLog: SessionLog = createSessionLog();
