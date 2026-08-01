/**
 * fetchGuard.mjs — refuse to fetch anything that is not a public https URL, and
 * re-check every redirect hop.
 *
 * acquire-dataset.mjs fetches a URL that comes from the dataset register (data),
 * so the URL is an SSRF sink. This is the guard, in its own module so it can be
 * unit-tested against exact hostnames rather than inferred from a script's exit
 * code — the first version of this check was silently broken (an anchored
 * alternation whose IP prefixes could never match a full address) and the
 * "it refused the metadata host" test passed only because the fetch to an
 * unreachable address failed on its own. tests/fetchGuard.test.ts pins the
 * predicate directly so that cannot recur.
 */

/**
 * Is this hostname on a private/loopback/link-local network? The IPv4 ranges
 * are matched as prefixes anchored at the START only — a full address like
 * `169.254.169.254` must match `^169\.254\.`, which an end-anchored prefix
 * never could.
 */
export function isPrivateHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '0.0.0.0' || h === '') return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.includes('intranet')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 loopback / ULA
  if (/^127\./.test(h)) return true; // IPv4 loopback
  if (/^10\./.test(h)) return true; // private
  if (/^192\.168\./.test(h)) return true; // private
  if (/^169\.254\./.test(h)) return true; // link-local (cloud metadata 169.254.169.254)
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true; // private 172.16–172.31
  return false;
}

/** A URL object's problem (not https, or a private host), or null when fetchable. */
export function hostProblem(u) {
  if (u.protocol !== 'https:') return `${JSON.stringify(u.href)} is not https`;
  if (isPrivateHost(u.hostname)) return `host ${JSON.stringify(u.hostname)} is private/loopback/link-local`;
  return null;
}

/** Validate a URL string; returns `{ url }` (a validated URL object) or `{ problem }`. */
export function checkUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { problem: `sourceUrl ${JSON.stringify(url)} is not a valid URL` };
  }
  const p = hostProblem(u);
  if (p) return { problem: `sourceUrl ${p}; refusing to fetch it` };
  return { url: u };
}

/**
 * Fetch, following redirects by hand and re-validating each hop's host, so a
 * public URL cannot 302 the request onto a private host (the metadata endpoint
 * is reached exactly this way). `fetchImpl` is injectable for tests. Returns
 * `{ res }` on success or `{ problem }` on a refused hop / too many redirects.
 */
export async function fetchValidated(startUrl, fetchImpl = fetch, maxHops = 5) {
  let current = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetchImpl(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { res };
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        return { problem: `redirect to an invalid URL ${JSON.stringify(loc)}` };
      }
      const bad = hostProblem(next);
      if (bad) return { problem: `redirect to ${bad}` };
      current = next;
      continue;
    }
    return { res };
  }
  return { problem: 'too many redirects' };
}
