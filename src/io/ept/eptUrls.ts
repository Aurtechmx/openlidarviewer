/**
 * eptUrls.ts
 *
 * URL construction for the three EPT dataset directories:
 *
 *   <root>/ept.json
 *   <root>/ept-hierarchy/D-X-Y-Z.json
 *   <root>/ept-data/D-X-Y-Z.<ext>
 *
 * The "root" is the directory containing `ept.json`. The streaming source
 * derives a `baseUrl` from the manifest URL on construction and uses these
 * helpers for every subsequent fetch.
 *
 * Pure — no I/O, no three.js. Driven entirely by the manifest URL the
 * user pasted into the viewer.
 */

import type { EptDataType, EptKey } from './eptTypes';
import { eptKeyToString } from './eptTypes';

/**
 * Derive the dataset's base URL (the directory containing `ept.json`)
 * from a manifest URL. Strips the `ept.json` filename and any query /
 * hash, returning a string that always ends with `/`.
 *
 *   "https://server/path/ept.json"     → "https://server/path/"
 *   "https://server/path/ept.json?t=1" → "https://server/path/"
 *   "https://server/path/"             → "https://server/path/"  (passthrough)
 */
export function eptBaseUrl(manifestUrl: string): string {
  // Use URL when we can; fall through to plain-string trim otherwise.
  let pathname: string;
  let origin = '';
  try {
    const u = new URL(manifestUrl);
    pathname = u.pathname;
    origin = u.origin;
  } catch {
    // Plain path or relative URL — operate on the string directly.
    pathname = manifestUrl.split('?')[0].split('#')[0];
  }
  // Strip a trailing `ept.json` if present.
  if (/\/ept\.json$/i.test(pathname)) {
    pathname = pathname.replace(/\/ept\.json$/i, '/');
  }
  // Ensure trailing slash.
  if (!pathname.endsWith('/')) pathname += '/';
  return origin + pathname;
}

/**
 * The auth/query string (e.g. `?token=abc`) carried on the manifest URL, to be
 * re-attached to every derived hierarchy / tile request. {@link eptBaseUrl}
 * strips the query when computing the dataset directory, so without this a
 * signed EPT dataset (Azure SAS, a CDN `?token`, or any prefix-scoped
 * credential) loads its `ept.json` and then 401/403s on the first hierarchy
 * fetch. Returns `''` when there is no query. (A per-OBJECT presigned signature
 * is bound to `ept.json` alone and still cannot authorise the hierarchy files —
 * that case surfaces as an honest hierarchy-fetch error, by design.)
 */
export function eptUrlSearch(manifestUrl: string): string {
  try {
    return new URL(manifestUrl).search;
  } catch {
    const q = manifestUrl.indexOf('?');
    return q < 0 ? '' : manifestUrl.slice(q).split('#')[0];
  }
}

/** URL for the root hierarchy file (always `0-0-0-0.json`). */
export function eptRootHierarchyUrl(baseUrl: string, search = ''): string {
  return `${baseUrl}ept-hierarchy/0-0-0-0.json${search}`;
}

/** URL for a linked hierarchy file at the given key. */
export function eptHierarchyUrl(baseUrl: string, key: EptKey, search = ''): string {
  return `${baseUrl}ept-hierarchy/${eptKeyToString(key)}.json${search}`;
}

/**
 * URL for a node's tile data. Extension depends on the dataType from the
 * manifest:
 *   • laszip    → `.laz`
 *   • binary    → `.bin`
 *   • zstandard → `.zst`
 *
 * `search` re-attaches the manifest's auth query (see {@link eptUrlSearch}).
 */
export function eptTileUrl(baseUrl: string, key: EptKey, dataType: EptDataType, search = ''): string {
  const ext = tileExtensionFor(dataType);
  return `${baseUrl}ept-data/${eptKeyToString(key)}.${ext}${search}`;
}

/** Tile filename extension for an EPT dataType. */
export function tileExtensionFor(dataType: EptDataType): string {
  switch (dataType) {
    case 'laszip':    return 'laz';
    case 'binary':    return 'bin';
    case 'zstandard': return 'zst';
  }
}
