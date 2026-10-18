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

/** Parse a strict dotted-quad IPv4 literal into four octets, or null. */
function parseIPv4(text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/** Is this IPv4 address (four octets) in a range a public fetch must never reach? */
function isPrivateIPv4([a, b, c]) {
  if (a === 0) return true; // 0.0.0.0/8, "this network"
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10, shared/carrier-grade NAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16-172.31
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24, IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15, benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/**
 * Parse an IPv6 literal (no brackets) into eight 16-bit groups, or null when it
 * is not a well-formed address. Handles `::` compression and an embedded
 * dotted IPv4 tail (`::ffff:127.0.0.1`); a `%zone` suffix is ignored.
 */
function parseIPv6(text) {
  let h = text;
  const zone = h.indexOf('%');
  if (zone !== -1) h = h.slice(0, zone);
  if (!h.includes(':')) return null;

  // An embedded IPv4 tail becomes the last two groups.
  const lastColon = h.lastIndexOf(':');
  const tail = h.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hex = (hi, lo) => ((hi << 8) | lo).toString(16);
    h = `${h.slice(0, lastColon + 1)}${hex(v4[0], v4[1])}:${hex(v4[2], v4[3])}`;
  }

  const halves = h.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part) => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0]);
  const rest = halves.length === 2 ? groupsOf(halves[1]) : [];
  const all = [...head, ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;

  let groups;
  if (halves.length === 2) {
    if (all.length > 7) return null; // `::` stands for at least one group
    groups = [...head, ...Array(8 - all.length).fill('0'), ...rest];
  } else {
    if (all.length !== 8) return null;
    groups = all;
  }
  return groups.map((g) => parseInt(g, 16));
}

/** Is this IPv6 address (eight groups) loopback, private, link-local or an embedded private IPv4? */
function isPrivateIPv6(g) {
  const v4From = (hi, lo) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  const zeros = (from, to) => g.slice(from, to).every((x) => x === 0);

  if (zeros(0, 6)) return isPrivateIPv4(v4From(g[6], g[7])); // `::`, `::1`, and the deprecated IPv4-compatible form
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(v4From(g[6], g[7])); // IPv4-mapped ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    // NAT64 well-known prefix 64:ff9b::/96 embeds the IPv4 target; the
    // local-use prefix 64:ff9b:1::/48 is not a public destination at all.
    return zeros(2, 6) ? isPrivateIPv4(v4From(g[6], g[7])) : g[2] === 1;
  }
  if (g[0] === 0x2002) return isPrivateIPv4(v4From(g[1], g[2])); // 6to4 embeds the IPv4 in groups 1-2
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Is this hostname on a private/loopback/link-local network, or a name that
 * only resolves inside one?
 *
 * IP literals are parsed, not prefix-matched: an IPv6 literal is checked
 * against the real ranges (loopback, fc00::/7, fe80::/10, multicast), and an
 * IPv4-mapped or otherwise embedded IPv4 address is re-checked as IPv4. Only a
 * string that parses as an IPv6 address is treated as one, so a registered
 * name that merely starts with "fd" or "fc" (fdroid.org) is an ordinary host.
 * Likewise only a full dotted quad counts as an IPv4 literal. Non-canonical
 * IPv4 spellings (`2130706433`, `0x7f.1`) are normalised by the URL parser
 * first. A trailing dot (`localhost.`) names the same host and is removed.
 *
 * What this cannot see is a public name whose DNS record points at a private
 * address; that needs resolution, which this check does not do.
 */
export function isPrivateHost(hostname) {
  let h = String(hostname).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '') return true;

  // An IPv6 literal contains a colon; nothing else in a hostname may.
  if (h.includes(':')) {
    const groups = parseIPv6(h);
    return groups === null ? true : isPrivateIPv6(groups); // unparseable: refuse
  }

  // A hostname carries none of these. Refuse rather than let the URL parser
  // below read the string as something else (`good.example/@127.0.0.1`).
  if (/[\s/\\?#@[\]]/.test(h)) return true;

  h = h.replace(/\.+$/, '');
  if (h === '') return true;

  // Canonicalise numeric IPv4 spellings and percent-escapes the way fetch would.
  try {
    h = new URL(`https://${h}/`).hostname.replace(/\.+$/, '');
  } catch {
    return true;
  }
  if (h.includes(':')) return isPrivateHost(h); // the parser produced an IPv6 form

  const v4 = parseIPv4(h);
  if (v4) return isPrivateIPv4(v4);

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain')) return true;
  if (h.endsWith('.home.arpa') || h.includes('intranet')) return true;
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
