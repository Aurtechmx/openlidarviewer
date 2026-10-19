/**
 * RangeSource.ts
 *
 * A range-readable byte source — the streaming primitive behind COPC. Unlike
 * the `PointCloudSource` (which decodes a whole cloud in one shot), a
 * `RangeSource` answers arbitrary `[offset, offset + length)` byte reads, so
 * the COPC pipeline can fetch just a header, a hierarchy page, or a single
 * octree node's chunk without ever reading the rest of the file.
 *
 * Three implementations ship: a dropped `File`, an in-memory `ArrayBuffer`
 * (the test substrate), and an HTTP Range source that streams a remote COPC
 * scan over `Range:` requests.
 *
 * Pure interface — no DOM, no three.js.
 */

/** The kind of byte source behind a {@link RangeSource}. */
export type RangeSourceKind = 'local-file' | 'array-buffer' | 'http-range';

/** A range-readable byte source. */
export interface RangeSource {
  /** A stable identifier — a file name, a URL, or a synthetic id. */
  id(): string;
  /** Which kind of source this is — drives diagnostics and routing. */
  kind(): RangeSourceKind;
  /** The total byte length of the source. */
  size(): Promise<number>;
  /**
   * Read `length` bytes starting at `offset`. A read that runs past the end is
   * truncated to the end; a zero-length read yields an empty buffer. Rejects
   * with a {@link RangeReadError} on a nonsensical request, an aborted signal,
   * or a transport failure.
   */
  readRange(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>;
  /** Release any held resources. Optional — a `File` source needs nothing. */
  close?(): Promise<void>;
}

/**
 * Why a range read failed — drives clear, categorised messaging. The set is
 * deliberately small but precise; Added the `timeout`,
 * `content-mismatch`, and `server-error` codes so the remote-COPC UX can show
 * a specific message instead of falling back to a generic transport label.
 */
export type RangeReadErrorCode =
  | 'out-of-range'
  | 'aborted'
  | 'transport'
  | 'range-unsupported'
  | 'timeout'
  | 'content-mismatch'
  // The remote object changed under a load in progress: a later response
  // carries a different validator (ETag / Last-Modified) or total size than the
  // one pinned at probe time, or the server failed our `If-Match`. Distinct
  // from a transport fault because the read cannot be retried into correctness
  // — the bytes already decoded belong to a version that no longer exists.
  | 'resource-changed'
  | 'server-error';

/** A typed range-read failure. */
export class RangeReadError extends Error {
  readonly code: RangeReadErrorCode;
  constructor(code: RangeReadErrorCode, message: string) {
    super(message);
    this.name = 'RangeReadError';
    this.code = code;
  }
}

/**
 * Validate a requested `[offset, length)` against a known total size and
 * return the *clamped* length: a read that runs past the end is truncated to
 * the end, and a zero-length read is legal. A negative or non-finite request,
 * or an offset past the end, throws `RangeReadError('out-of-range')`.
 *
 * Pure — the single shared range-validation routine for every implementation.
 */
export function clampRange(offset: number, length: number, size: number): number {
  if (
    !Number.isFinite(offset) ||
    !Number.isFinite(length) ||
    offset < 0 ||
    length < 0
  ) {
    throw new RangeReadError(
      'out-of-range',
      `Invalid range request: offset=${offset}, length=${length}`,
    );
  }
  if (offset > size) {
    throw new RangeReadError(
      'out-of-range',
      `Range offset ${offset} is past the source size ${size}`,
    );
  }
  return Math.min(length, size - offset);
}

/** Maximum acceptable length of a `?copc=` URL — guards URL-bomb input. */
export const MAX_REMOTE_COPC_URL_LENGTH = 2048;

/**
 * True when the page itself is served from a loopback development host. Only
 * then may a remote dataset URL use plain `http:`; a deployed page (always
 * https) accepts https only, so a dataset is never read over a channel an
 * on-path attacker can rewrite.
 */
export function isLocalDevPage(): boolean {
  const host = (globalThis as { location?: { hostname?: string } }).location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * URL hygiene for every remote-dataset entry (the URL field, the `?copc=` deep
 * link, a catalog pick; COPC, EPT and 3D Tiles all delegate here). The URL must
 * parse, use `https:` (`http:` only when {@link isLocalDevPage}), fit within
 * {@link MAX_REMOTE_COPC_URL_LENGTH}, carry no userinfo (`user:pass@…`, never
 * expose credentials through a scan link), and not name a private host.
 * Returns the original URL on success and a precise reason on failure.
 */
export function validateRemoteCopcUrl(
  raw: string,
  opts: { readonly allowHttp?: boolean } = {},
):
  | { ok: true; url: string }
  | { ok: false; reason: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, reason: 'No URL was provided.' };
  }
  if (raw.length > MAX_REMOTE_COPC_URL_LENGTH) {
    return {
      ok: false,
      reason: `URL is longer than ${MAX_REMOTE_COPC_URL_LENGTH} characters.`,
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL is not parseable.' };
  }
  const allowHttp = opts.allowHttp ?? isLocalDevPage();
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    return {
      ok: false,
      reason: 'Only https:// URLs are accepted.',
    };
  }
  if (u.username !== '' || u.password !== '') {
    return {
      ok: false,
      reason: 'URLs with embedded credentials are not accepted.',
    };
  }
  // SSRF hardening: refuse loopback, private, link-local, and other
  // internal hosts so a pasted URL can't be used to probe the user's own
  // network (router admin pages, metadata endpoints, intranet services).
  if (isBlockedHost(u.hostname)) {
    return {
      ok: false,
      reason: 'URLs pointing at localhost or a private network address are not accepted.',
    };
  }
  return { ok: true, url: raw };
}

/** Conventional private-network name suffixes; a name is blocked when it ends with one or equals one without its dot. */
const BLOCKED_NAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.lan',
  '.home.arpa',
  '.intranet',
  '.corp',
  '.private',
] as const;

/** True for an IPv4 address in a loopback, private, shared, link-local, reserved or multicast range. */
function isBlockedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this-network, RFC 1918, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved, 255.255.255.255 broadcast
  return false;
}

/**
 * Expand an IPv6 literal (no brackets) into its eight 16-bit groups, or null
 * when it does not parse. A trailing dotted quad (`::ffff:127.0.0.1`) is folded
 * into two groups, a zone id is ignored.
 */
function parseIpv6(literal: string): number[] | null {
  let s = literal;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (quad) {
    const o = quad.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, quad.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail];
  return all.length === 8 && all.every((g) => Number.isInteger(g)) ? all : null;
}

/**
 * True for an IPv6 literal that is, or embeds, an address a remote-data URL
 * must never target. Unparseable literals are refused.
 */
function isBlockedIpv6(literal: string): boolean {
  const g = parseIpv6(literal);
  if (!g) return true;
  const embedded = (hi: number, lo: number): boolean => isBlockedIpv4(hi >> 8, hi & 0xff, lo >> 8);
  // ::/96 (unspecified, loopback and the deprecated IPv4-compatible form that
  // embeds an IPv4 address in the low 32 bits): refused whole.
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  // ::ffff:0:0/96 IPv4-mapped, and ::ffff:0:0:0/96 IPv4-translated (SIIT):
  // judged by the IPv4 address they carry.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6], g[7]);
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return embedded(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
  if (g[0] === 0x2002) return true; // 2002::/16 6to4 (embeds an IPv4 address)
  if (g[0] === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo (embeds an IPv4 address)
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 discard-only
  return false;
}

/**
 * True for hostnames that resolve to the local machine or a private /
 * internal network range, which a remote-data URL must never target.
 *
 * Covers IPv4 (this-network, loopback, RFC 1918, link-local, CGNAT, the
 * 192.0.0.0/24 and 198.18.0.0/15 special ranges, multicast and reserved space
 * to 255.255.255.255); IPv6 (`::/96`, loopback, mapped and translated forms
 * judged by the IPv4 address they carry, NAT64, 6to4, Teredo, link-local,
 * site-local, unique-local, multicast, discard-only); bare single-label names
 * such as `intranet` or `router`, which only resolve on a local search domain;
 * and the conventional private-network suffixes.
 *
 * This is a literal check on the text of the host. It does not resolve DNS,
 * so a public-looking name whose A record points at a private address (for
 * example `127.0.0.1.nip.io`) cannot be refused here; a browser-side app
 * cannot see the resolved address before the request is made. The check closes
 * the literal and naming routes, not DNS rebinding.
 */
export function isBlockedHost(hostname: string): boolean {
  // Strip brackets AND any trailing dot(s): a root-anchored FQDN like
  // "localhost." or "svc.internal." resolves to the same host but would slip
  // past the equality / endsWith checks below.
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
  if (h === '') return true;
  if (h.includes(':')) return isBlockedIpv6(h);
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) return isBlockedIpv4(Number(m[1]), Number(m[2]), Number(m[3]));
  // A name with no dot is a single label (`localhost`, `intranet`, `router`):
  // it resolves through the local search domain, never from the public DNS.
  if (!h.includes('.')) return true;
  return BLOCKED_NAME_SUFFIXES.some((suffix) => h.endsWith(suffix) || h === suffix.slice(1));
}

/**
 * Strip userinfo AND query parameters from a URL so it is safe to
 * surface in error messages, telemetry, or logs. The query string is
 * scrubbed because signed-URL schemes (Azure SAS, AWS presigned URLs,
 * object-store signed URLs) carry the credential in the query
 * — leaking it into a thrown error would put a working bearer token
 * into the UI / console / sentry trail.
 *
 * Falls back to a literal substring strip when the URL doesn't parse,
 * so a malformed input is still scrubbed.
 */
export function sanitizeUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    if (u.search) {
      // We strip the entire query string rather than per-key
      // allow-listing — the threat model is "we don't know which key
      // is the credential", so the only safe move is to drop it all
      // and surface "?…" so the caller knows there were params.
      u.search = '';
      return `${u.toString()}?…`;
    }
    return u.toString();
  } catch {
    // Best-effort textual scrub for inputs that won't parse — strip
    // the first `userinfo@` segment AND any query string.
    const noUserInfo = raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1');
    return noUserInfo.replace(/\?.*$/, '?…');
  }
}
