/**
 * tilesetUrl.ts — URL hygiene for a remote 3D Tiles entry, and the safe
 * resolution of the URLs its content names.
 *
 * A `tileset.json` is remote input whose CONTENT names more URLs to fetch. That
 * is the difference between this module and `eptUrls.ts`: an EPT dataset's
 * hierarchy and tile URLs are DERIVED from the manifest URL by a fixed naming
 * rule, so nothing the manifest says can redirect a fetch. A tileset instead
 * carries `content.uri` strings written by whoever authored the document, and a
 * viewer that resolves them with `new URL(uri, base)` and fetches the result
 * will happily fetch `https://elsewhere.example/collect?...`, `//evil.example/x`,
 * a `data:` payload, or `../../../secrets.json`.
 *
 * So resolution here is a decision, not a concatenation:
 *
 *   scheme      http/https only, which rejects data:, blob:, file:, javascript:
 *   host        must be the tileset's own origin, which rejects an absolute or
 *               protocol-relative URI pointing anywhere else
 *   path        must stay at or below the tileset's own directory, which
 *               rejects a `../` walk up to a sibling prefix on the same host
 *   userinfo    rejected, as on every other remote entry in the app
 *   length      capped, so a pathological URI cannot be assembled at all
 *
 * The entry URL itself goes through the shared `validateRemoteCopcUrl`, which
 * is where the SSRF host block-list (`isBlockedHost`: loopback, RFC 1918,
 * link-local, CGNAT, unique-local, `.internal` / `.local` suffixes) lives. The
 * origin check above is what extends that one gate to every derived fetch:
 * because a content URI can never leave the validated origin, it can never
 * reach a host the block-list did not already see.
 *
 * Pure — no fetch, no DOM.
 */

import {
  validateRemoteCopcUrl,
  isBlockedHost,
  MAX_REMOTE_COPC_URL_LENGTH,
} from '../range/RangeSource';
import { is3dTilesName } from '../sniffFormat';

/** Maximum acceptable length of a tileset URL — same guard as the COPC entry. */
export const MAX_REMOTE_TILESET_URL_LENGTH = MAX_REMOTE_COPC_URL_LENGTH;

/**
 * Ceiling for a single `content.uri` string, before resolution.
 *
 * Short enough that no legitimate relative path comes near it, and long enough
 * that the check never fires on a real dataset. The RESOLVED URL is checked
 * against the full URL-length cap separately, because a short URI appended to a
 * long base can still exceed it.
 */
export const MAX_CONTENT_URI_LENGTH = 1024;

/**
 * True when `url` is a 3D Tiles entry point (a `tileset.json`).
 *
 * URL-pattern only — no network, no schema fetch — so a router can dispatch on
 * it synchronously, exactly as {@link import('../../app/openStreaming').isEptUrl}
 * does for EPT. The filename rule is {@link is3dTilesName}, reused rather than
 * restated so the sniffer and the router cannot drift apart. A URL `new URL`
 * cannot parse still gets a raw-string test, so routing stays deterministic
 * instead of throwing.
 */
export function isTilesetUrl(url: string): boolean {
  try {
    return is3dTilesName(new URL(url).pathname);
  } catch {
    return is3dTilesName(url);
  }
}

/** The result shape every validator in this module returns. */
export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Validate a remote 3D Tiles entry URL.
 *
 * Layers on `validateRemoteCopcUrl` — http/https only, no userinfo, length cap,
 * and the shared `isBlockedHost` SSRF barrier — with the 3D Tiles requirement
 * that the path name the canonical `tileset.json` entrypoint. Returns the
 * original URL on success so callers fetch the string that passed the gate.
 */
export function validateRemoteTilesetUrl(raw: string): UrlCheck {
  const base = validateRemoteCopcUrl(raw);
  if (!base.ok) return base;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // validateRemoteCopcUrl already proved this parses; guard rather than assert.
    return { ok: false, reason: 'URL is not parseable.' };
  }
  if (!is3dTilesName(u.pathname)) {
    return {
      ok: false,
      reason: 'A 3D Tiles URL must end in /tileset.json (the tileset entrypoint).',
    };
  }
  return { ok: true, url: raw };
}

/**
 * The directory containing the entry `tileset.json`, always ending in `/`.
 *
 * Query and fragment are dropped: they belong to the manifest request, and
 * {@link tilesetUrlSearch} carries the auth half of them forward separately.
 */
export function tilesetBaseUrl(entryUrl: string): string {
  const u = new URL(entryUrl);
  const pathname = u.pathname.replace(/[^/]*$/, '');
  return `${u.origin}${pathname.endsWith('/') ? pathname : `${pathname}/`}`;
}

/**
 * The auth/query string carried on the entry URL, to be re-attached to derived
 * requests. Mirrors `eptUrlSearch`: a prefix-scoped credential (an Azure SAS, a
 * CDN `?token=`) authorises the whole directory, and dropping it loads the
 * tileset and then 403s on the first tile. Returns `''` when there is none.
 */
export function tilesetUrlSearch(entryUrl: string): string {
  try {
    return new URL(entryUrl).search;
  } catch {
    const q = entryUrl.indexOf('?');
    return q < 0 ? '' : entryUrl.slice(q).split('#')[0]!;
  }
}

/**
 * Resolve one `content.uri` against the tileset's base directory, or refuse it.
 *
 * The refusals are the point of the function; see the module comment for what
 * each one keeps out. `search` is appended only when the URI carries no query
 * of its own, so an authored `?v=2` is never silently replaced by the entry
 * credential.
 */
export function resolveTilesetContentUrl(
  baseUrl: string,
  contentUri: string,
  search = '',
): UrlCheck {
  if (typeof contentUri !== 'string' || contentUri.length === 0) {
    return { ok: false, reason: 'A tile content URI is empty.' };
  }
  if (contentUri.length > MAX_CONTENT_URI_LENGTH) {
    return {
      ok: false,
      reason: `A tile content URI is longer than ${MAX_CONTENT_URI_LENGTH} characters.`,
    };
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'The tileset base URL is not parseable.' };
  }
  let resolved: URL;
  try {
    resolved = new URL(contentUri, base);
  } catch {
    return { ok: false, reason: `A tile content URI is not resolvable: ${contentUri}` };
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return {
      ok: false,
      reason: `A tile content URI uses the ${resolved.protocol} scheme; only http and https are fetched.`,
    };
  }
  if (resolved.username !== '' || resolved.password !== '') {
    return { ok: false, reason: 'A tile content URI carries embedded credentials.' };
  }
  // The entry URL passed the SSRF block-list; a content URI that stays on that
  // origin inherits the result. One that leaves it has never been checked, and
  // checking it here would still be checking a host the user never chose — so
  // it is refused outright rather than re-validated.
  if (resolved.origin !== base.origin) {
    return {
      ok: false,
      reason: `A tile content URI points outside the tileset's own host (${resolved.host}).`,
    };
  }
  // Belt and braces: `origin` equality already implies this, but the block-list
  // is the guarantee being relied on and it costs one call to state it directly.
  if (isBlockedHost(resolved.hostname)) {
    return { ok: false, reason: 'A tile content URI points at a private network address.' };
  }
  // `new URL` normalises `..` before this runs, so the comparison is against the
  // real path the fetch would use rather than the text the document wrote.
  if (!resolved.pathname.startsWith(base.pathname)) {
    return {
      ok: false,
      reason: `A tile content URI escapes the tileset directory (${resolved.pathname}).`,
    };
  }
  if (resolved.search === '' && search !== '') resolved.search = search;
  // A short URI on a long base can still assemble past the entry-URL ceiling.
  const out = resolved.toString();
  if (out.length > MAX_REMOTE_TILESET_URL_LENGTH) {
    return { ok: false, reason: 'A resolved tile content URL is too long.' };
  }
  return { ok: true, url: out };
}
