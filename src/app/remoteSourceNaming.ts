/**
 * remoteSourceNaming.ts — display names and error text for remote scans.
 *
 * Three helpers lifted out of main.ts: name an EPT or COPC source from its url,
 * and turn a range-read failure into a message with an honest remedy. All pure
 * string and URL work, and the kind that breaks on the inputs nobody types by
 * hand — percent-encoded path segments, a trailing slash, a url with no file
 * part, a malformed url that must degrade rather than throw.
 */

import { RangeReadError, sanitizeUrlForDisplay } from '../io/range/RangeSource';

/**
 * Display name for a remote EPT source: the dataset folder that holds
 * `ept.json`, tagged so the layer list reads "<name> (EPT)". Falls back to
 * `remote.ept` when the url has no usable folder or does not parse.
 */
export function remoteEptName(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/\/ept\.json$/i, '');
    const last = path.slice(path.lastIndexOf('/') + 1);
    return last ? `${decodeURIComponent(last)} (EPT)` : 'remote.ept';
  } catch {
    return 'remote.ept';
  }
}

/**
 * Display name for a remote COPC source: the file name from the url path.
 * Falls back to `remote.copc.laz` on a trailing slash or a url that does not
 * parse.
 */
export function remoteCopcName(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.slice(path.lastIndexOf('/') + 1);
    return last ? decodeURIComponent(last) : 'remote.copc.laz';
  } catch {
    return 'remote.copc.laz';
  }
}

/** The host of a url, or the input verbatim when it does not parse. */
export function shortHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Turn a remote-COPC failure into a clear message with a remedy.
 *
 * `RangeReadError` already classifies the range-read failures — an unreachable
 * or CORS-blocked host, a host with no range support, a proxy that ignored the
 * range. Each recognised code appends the specific fix. An unrecognised range
 * code returns its own message unchanged. A non-range error most often means
 * the url is reachable but the file behind it is not a valid COPC, so the
 * message names the host and says so.
 */
export function describeRemoteCopcError(err: unknown, url: string): string {
  const safeUrl = sanitizeUrlForDisplay(url);
  if (err instanceof RangeReadError) {
    if (err.code === 'range-unsupported') {
      return `${err.message} Try hosting the file on S3 or a static CDN — most support range requests by default.`;
    }
    if (err.code === 'transport') {
      return `${err.message} The host also needs to allow cross-origin (CORS) requests from this site.`;
    }
    if (err.code === 'timeout') {
      return `${err.message} Try again in a moment, or pick a faster host.`;
    }
    if (err.code === 'content-mismatch') {
      return `${err.message} This usually means a proxy or CDN ignored the byte-range request.`;
    }
    if (err.code === 'server-error') {
      return `${err.message} The host returned a server-side error — wait a moment and try again.`;
    }
    return err.message;
  }
  const detail = err instanceof Error ? err.message : 'unknown error';
  return `${shortHost(safeUrl)} was reached, but it could not be read as a COPC scan — ${detail}.`;
}
