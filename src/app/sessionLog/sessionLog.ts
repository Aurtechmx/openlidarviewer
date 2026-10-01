/**
 * sessionLog.ts
 *
 * The Session log: an append-only, in-memory list of what was done to the
 * scans in this browser tab and what came of it. Nothing here is persisted or
 * sent anywhere; reloading the page starts an empty log.
 *
 * The store holds display text only. Every text that could carry a file
 * location goes through {@link redactPaths} on the way in, so a log copied
 * into a bug report names a local file by its name alone and a link by its
 * host and file name, never by a folder, a query or a token.
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

const LINK = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;
/** Schemes whose whole body is data, an address or code: only the scheme is kept. */
const OPAQUE = /^(data|blob|mailto|javascript|vbscript|tel|sms):/i;
const opaqueText = (v: string): string => `${OPAQUE.exec(v)![1]!.toLowerCase()}:…`;
/** A last segment that carries a credential: a query pair, or a JWT's three parts. */
const TOKEN_NAME = /[=&]|^eyJ[\w-]*\.[\w-]+\./;

/** What a link keeps: its origin and, when it names a file, that file's name. */
interface LinkParts {
  /** `scheme://host[:port]`, or '' for a local `file:` link. */
  readonly origin: string;
  /** The last path segment when it looks like a file name, else ''. */
  readonly name: string;
  /** Whether the path had more than the one segment shown. */
  readonly deeper: boolean;
}

function linkParts(raw: string): LinkParts | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const segs = url.pathname.split('/').filter((x) => x.length > 0);
  let name = (segs[segs.length - 1] ?? '').split(';')[0] ?? '';
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the encoded form */
  }
  // Decoding can bring back a `?` or `#`; nothing after one is a file name.
  name = name.split(/[?#;]/)[0] ?? '';
  // A segment with no file extension can be an access token: drop it.
  if (!/\.[a-z0-9]{1,8}$/i.test(name) || TOKEN_NAME.test(name)) name = '';
  // `host` carries the port and never the user name or password.
  const origin = url.protocol === 'file:' ? '' : `${url.protocol}//${url.host}`;
  return { origin, name, deeper: segs.length > 1 || (segs.length === 1 && !name) };
}

/**
 * The last segment of a file name, path or link. A local name keeps `#`, `?`
 * and `%`; only a link (`scheme://`) is parsed, and from a link only the file
 * name is kept.
 */
export function baseName(value: string): string {
  const v = value.trim();
  if (OPAQUE.test(v)) return opaqueText(v);
  if (LINK.test(v)) {
    const parts = linkParts(v);
    if (parts) return parts.name || parts.origin.replace(/^[a-z0-9+.-]+:\/\//i, '');
  }
  const segs = v.split(/[\\/]/).filter((x) => x.length > 0);
  return segs[segs.length - 1] ?? '';
}

function linkText(raw: string): string {
  if (OPAQUE.test(raw)) return opaqueText(raw);
  const parts = linkParts(raw);
  if (!parts) return '(link)';
  if (!parts.origin) return parts.name || '(file)';
  if (!parts.name) return parts.deeper ? `${parts.origin}/…` : parts.origin;
  return `${parts.origin}/${parts.deeper ? '…/' : ''}${parts.name}`;
}

/** Split sentence punctuation (and an unmatched closing bracket) off a link's end. */
function trimTail(m: string): [string, string] {
  let end = m.length;
  const count = (c: string, upTo: number): number => {
    let n = 0;
    for (let i = 0; i < upTo; i++) if (m[i] === c) n++;
    return n;
  };
  while (end > 0) {
    const ch = m[end - 1]!;
    if ('.,;:!?\'"'.includes(ch)) end--;
    else if (ch === ')' && count('(', end) < count(')', end)) end--;
    else if (ch === ']' && count('[', end) < count(']', end)) end--;
    else break;
  }
  return [m.slice(0, end), m.slice(end)];
}

// One pass, so a replacement is never scanned again. Groups, in order:
// 1 an opaque link (data:, blob:, mailto:, javascript: and the like), 2 a link
// with a scheme, which runs on past a space to a word that holds `/` or `=`,
// with up to three plain words between, 3 the folders of a
// Windows drive path (either slash), 4 the folders of a UNC path, 5 the folders
// of a home-relative path, 6 the character before a POSIX path and 7 that
// path's folders. A folder name may hold single spaces. Every quantifier is
// bounded by the next separator, so a crafted line costs linear time.
const WIN_SEG = String.raw`[^\\/\s:*?"<>|]+(?: [^\\/\s:*?"<>|]+)*`;
const POSIX_SEG = String.raw`[^/\s"'<>]+(?: [^/\s"'<>]+)*`;
const PATH_PATTERN = new RegExp(
  [
    String.raw`(\b(?:data|blob|mailto|javascript|vbscript|tel|sms):[^\s"'<>]+)`,
    String.raw`(\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+(?:(?: [^\s"'<>/=]+){0,3} [^\s"'<>/=]*[/=][^\s"'<>]*)*)`,
    String.raw`(\b[a-z]:[\\/](?:${WIN_SEG}[\\/])*)`,
    String.raw`(\\\\(?:${WIN_SEG}[\\/])+)`,
    String.raw`(~[\\/](?:${POSIX_SEG}[\\/])*)`,
    String.raw`(^|[\s("'=:\[\x60])(\/(?:${POSIX_SEG}\/)+)`,
  ].join('|'),
  'gi',
);

/** Replace every link with its origin and file name, and drop the folders of every local path. */
export function redactPaths(text: string): string {
  return text.replace(PATH_PATTERN, (_m: string, opaque?: string, link?: string, win?: string, unc?: string, home?: string, lead?: string) => {
    if (opaque) {
      const [body, tail] = trimTail(opaque);
      return linkText(body) + tail;
    }
    if (link) {
      const [body, tail] = trimTail(link);
      return linkText(body) + tail;
    }
    if (win || unc || home) return '';
    return lead ?? '';
  });
}

function clean(text: string): string {
  // Cut first: redaction is linear, but a megabyte message is still a megabyte.
  const one = redactPaths(text.slice(0, MAX_TEXT * 4)).replace(/\s+/g, ' ').trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}

function safeScan(fn: (() => string | null) | null): string | null {
  try {
    return fn ? fn() : null;
  } catch {
    return null;
  }
}

/**
 * Whether a name is a path with folders. An absolute, home, drive or UNC path
 * is one; so is a relative one whose folders hold no space ("data/sub/a").
 * "Area 1/2 (EPT)" and "part 3/4.laz" are names.
 */
function isPath(v: string): boolean {
  if (v.includes('\\') || /^[/~]/.test(v) || /^[a-z]:[\\/]/i.test(v)) return true;
  const segs = v.split('/');
  return segs.length > 1 && segs.slice(0, -1).every((s) => s.length > 0 && !/\s/.test(s));
}

/**
 * A scan's display name. A link or a path keeps only its file name; any other
 * name is kept whole, slashes and all.
 */
export function scanName(name: string): string {
  const v = name.trim();
  return (OPAQUE.test(v) || LINK.test(v) || isPath(v) ? baseName(v) : '') || v;
}

function scanOf(name: string | null): string | null {
  return name ? clean(scanName(name)) : null;
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
