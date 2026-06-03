/**
 * eptUrlValidation.ts — Remote-UX polish for EPT.
 *
 * The COPC remote entry has had `validateRemoteCopcUrl` +
 * `describeRemoteCopcError` Ships EPT streaming as a
 * peer of COPC and this module gives the EPT entry the same fail-fast
 * URL hygiene + classified-error polish so a misconfigured host fails
 * with a precise reason rather than a stalled load.
 *
 * Pure — no DOM, no three.js, no fetch — unit-tested in Node.
 */

import {
  MAX_REMOTE_COPC_URL_LENGTH,
  validateRemoteCopcUrl,
  sanitizeUrlForDisplay,
} from '../range/RangeSource';

/** Maximum acceptable length of an EPT URL — same guard as the COPC entry. */
export const MAX_REMOTE_EPT_URL_LENGTH = MAX_REMOTE_COPC_URL_LENGTH;

/**
 * Validate a remote EPT entry URL. The rules layer on top of
 * `validateRemoteCopcUrl` (http/https only, no userinfo, length cap),
 * with an extra EPT-specific requirement: the path must end in
 * `/ept.json` (the canonical EPT entrypoint). Returns the original URL
 * on success and a precise reason on failure.
 */
export function validateRemoteEptUrl(
  raw: string,
):
  | { ok: true; url: string }
  | { ok: false; reason: string } {
  // Lean on the shared validator for scheme / userinfo / length checks.
  const base = validateRemoteCopcUrl(raw);
  if (!base.ok) return base;

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // validateRemoteCopcUrl already proved this parses, but TS doesn't
    // know that — guard defensively rather than non-null-assert.
    return { ok: false, reason: 'URL is not parseable.' };
  }
  // Strip query/fragment for the path check — `?token=...` is permitted.
  if (!/\/ept\.json$/i.test(u.pathname)) {
    return {
      ok: false,
      reason: 'EPT URL must end in /ept.json (the EPT manifest entrypoint).',
    };
  }
  return { ok: true, url: raw };
}

/**
 * Turn a remote-EPT failure into a clear, honest message. Distinguishes
 * the common failure modes:
 *   - manifest fetch rejected (CORS, 404, 5xx) — surfaced as fetch error
 *   - manifest parsed but invalid — the typed `parseEptMetadata` reason
 *   - hierarchy / tile fetch failure — same fetch-error shape
 *   - transport error (network down, DNS) — generic but URL-anchored
 *
 * The error message returned is safe to display verbatim; the URL is
 * scrubbed of credentials via {@link sanitizeUrlForDisplay} before
 * inclusion.
 */
export function describeRemoteEptError(err: unknown, url: string): string {
  const safeUrl = sanitizeUrlForDisplay(url);
  const shortHost = (() => {
    try {
      return new URL(safeUrl).host;
    } catch {
      return safeUrl;
    }
  })();
  const detail = err instanceof Error ? err.message : String(err);

  // Pattern-match common failure shapes for clearer messaging.
  if (/CORS|Cross-Origin|Access-Control/i.test(detail)) {
    return (
      `${shortHost} blocked the EPT request (CORS). ` +
      `Host the dataset where the server sends cross-origin headers ` +
      `(Access-Control-Allow-Origin) — most object stores can be configured to.`
    );
  }
  if (/manifest fetch failed.*\b40[34]\b/i.test(detail)) {
    return (
      `EPT manifest not found at ${shortHost} (404). ` +
      `Check that ept.json is at the URL you provided.`
    );
  }
  if (/manifest fetch failed.*\b5\d\d\b/i.test(detail)) {
    return (
      `${shortHost} returned a server-side error while reading the EPT manifest. ` +
      `Wait a moment and try again.`
    );
  }
  if (/manifest fetch failed/i.test(detail)) {
    return `${shortHost} rejected the EPT manifest request — ${detail}.`;
  }
  if (/Not a valid EPT manifest/i.test(detail)) {
    // parseEptMetadata's reason is already user-readable; surface verbatim.
    return detail;
  }
  if (/EPT hierarchy fetch failed/i.test(detail)) {
    return (
      `${shortHost} accepted the manifest but failed to serve a hierarchy file — ${detail}. ` +
      `The dataset may be partially uploaded or its directory layout broken.`
    );
  }
  if (/EPT tile fetch failed/i.test(detail)) {
    return (
      `${shortHost} accepted the manifest but failed to serve a point-data tile — ${detail}. ` +
      `Try again — a one-off transport failure may resolve.`
    );
  }
  if (/TypeError.*fetch|Failed to fetch|NetworkError/i.test(detail)) {
    return (
      `${shortHost} is unreachable. ` +
      `Check the URL, verify the host is online, and confirm CORS headers are set.`
    );
  }
  // Fallback — anchor the URL so the user knows which host failed.
  return `${shortHost} was reached, but the EPT load failed — ${detail}.`;
}
