/**
 * The SSRF guard for acquire-dataset. It was silently broken once — an anchored
 * alternation whose IPv4 prefixes could never match a full address, so it
 * blocked only `localhost` while every private range sailed through, and the
 * "it refused the metadata host" check passed only because the fetch to an
 * unreachable address failed on its own. These tests exercise the predicate
 * directly and drive the redirect path with an injected fetch, so neither the
 * dead-regex nor the redirect-follow hole can come back unnoticed.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs guard, no declaration file
import { isPrivateHost, hostProblem, checkUrl, fetchValidated } from '../scripts/lib/fetchGuard.mjs';

describe('isPrivateHost', () => {
  it('blocks loopback, private, and link-local hosts', () => {
    for (const h of [
      '169.254.169.254', // cloud metadata — the canonical SSRF target
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '192.168.1.1',
      '172.16.0.1', '172.31.255.255', 'localhost', '0.0.0.0',
      'foo.local', 'svc.internal', '::1',
    ]) {
      expect(isPrivateHost(h), `${h} must be blocked`).toBe(true);
    }
  });

  it('allows genuine public hosts, including near-miss ranges', () => {
    for (const h of [
      's3-us-west-2.amazonaws.com', 'example.org', 'zenodo.org',
      '169.253.0.1', // one octet off the link-local range
      '172.15.0.1', '172.32.0.1', // just outside 172.16–172.31
      '11.0.0.1', // not 10.
    ]) {
      expect(isPrivateHost(h), `${h} must be allowed`).toBe(false);
    }
  });
});

describe('isPrivateHost: IPv6 literals and normalised names', () => {
  it('blocks loopback, link-local and unique-local IPv6 literals in every spelling', () => {
    for (const h of [
      '::1', '[::1]', '0:0:0:0:0:0:0:1', '::', '[::]',
      'fe80::1', '[fe80::1]', 'FE80::1%eth0', 'febf::1', // fe80::/10 upper edge
      'fc00::1', 'fd12:3456:789a::1', 'fdff:ffff::1', // fc00::/7
      'ff02::1', // multicast
      'fec0::1', // deprecated site-local
    ]) {
      expect(isPrivateHost(h), `${h} must be blocked`).toBe(true);
    }
  });

  it('re-checks an IPv4 address embedded in an IPv6 literal as IPv4', () => {
    for (const h of [
      '::ffff:127.0.0.1', '[::ffff:127.0.0.1]', '::ffff:7f00:1', '::FFFF:7F00:1',
      '::ffff:169.254.169.254', '::ffff:a00:1', // 10.0.0.1
      '::ffff:192.168.1.1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::',
    ]) {
      expect(isPrivateHost(h), `${h} must be blocked`).toBe(true);
    }
    for (const h of ['::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::']) {
      expect(isPrivateHost(h), `${h} embeds a public IPv4 and must be allowed`).toBe(false);
    }
  });

  it('allows public IPv6 literals and the edges just outside the blocked ranges', () => {
    for (const h of [
      '2001:4860:4860::8888', '[2606:4700:4700::1111]',
      'fe7f::1', // just below fe80::/10
      'fbff::1', // just below fc00::/7
      'fe00::1', // not link-local
    ]) {
      expect(isPrivateHost(h), `${h} must be allowed`).toBe(false);
    }
  });

  it('refuses a malformed IPv6 literal rather than guessing', () => {
    for (const h of ['::1::2', '1:2:3', 'g::1', '1:2:3:4:5:6:7:8:9', '::ffff:999.0.0.1', '12345::1']) {
      expect(isPrivateHost(h), `${h} must be refused`).toBe(true);
    }
  });

  it('does not mistake a registered name that starts with fc or fd for IPv6', () => {
    for (const h of ['fdroid.org', 'f-droid.org', 'fd.example.org', 'fcbayern.com', 'fc00.example.org', 'FDROID.ORG']) {
      expect(isPrivateHost(h), `${h} is an ordinary public name`).toBe(false);
    }
  });

  it('treats a trailing dot as the same host', () => {
    expect(isPrivateHost('localhost.')).toBe(true);
    expect(isPrivateHost('LOCALHOST.')).toBe(true);
    expect(isPrivateHost('foo.local.')).toBe(true);
    expect(isPrivateHost('127.0.0.1.')).toBe(true);
    expect(isPrivateHost('svc.internal.')).toBe(true);
    expect(isPrivateHost('zenodo.org.')).toBe(false);
    expect(isPrivateHost('.')).toBe(true);
  });

  it('normalises non-canonical IPv4 spellings and percent-escapes', () => {
    for (const h of ['2130706433', '0x7f.0.0.1', '017700000001', '127.1', '%31%32%37.0.0.1', '0x7f000001']) {
      expect(isPrivateHost(h), `${h} must be blocked`).toBe(true);
    }
  });

  it('covers the other non-routable IPv4 ranges and *.localhost names', () => {
    for (const h of ['100.64.0.1', '100.100.100.200', '100.127.255.255', '198.18.0.1', '192.0.0.1', '224.0.0.1', '255.255.255.255', '0.1.2.3', 'app.localhost', 'nas.home.arpa', 'x.localdomain']) {
      expect(isPrivateHost(h), `${h} must be blocked`).toBe(true);
    }
    for (const h of ['100.63.255.255', '100.128.0.1', '198.17.255.255', '198.20.0.1', '192.0.2.1', '223.255.255.255']) {
      expect(isPrivateHost(h), `${h} must be allowed`).toBe(false);
    }
  });

  it('refuses a host string that carries URL syntax instead of re-parsing it', () => {
    for (const h of ['good.example/@127.0.0.1', 'a b', 'example.org?x', 'user@example.org']) {
      expect(isPrivateHost(h), `${h} must be refused`).toBe(true);
    }
  });
});

describe('checkUrl', () => {
  it('refuses the IPv6 and trailing-dot forms that used to pass', () => {
    for (const url of ['https://[::ffff:127.0.0.1]/', 'https://[fe80::1]/', 'https://localhost./', 'https://[fd00::1]/', 'https://[::ffff:169.254.169.254]/latest']) {
      expect(checkUrl(url).problem, url).toMatch(/private\/loopback\/link-local/);
    }
  });
  it('accepts fdroid.org and a public IPv6 literal', () => {
    expect(checkUrl('https://fdroid.org/repo/index.xml').problem).toBeUndefined();
    expect(checkUrl('https://[2606:4700:4700::1111]/x').problem).toBeUndefined();
  });

  it('refuses non-https', () => {
    expect(checkUrl('http://example.org/x').problem).toMatch(/is not https/);
  });
  it('refuses a private host', () => {
    expect(checkUrl('https://169.254.169.254/latest').problem).toMatch(/private\/loopback\/link-local/);
  });
  it('returns a validated URL object for a public https url', () => {
    const r = checkUrl('https://s3-us-west-2.amazonaws.com/bucket/file.json');
    expect(r.problem).toBeUndefined();
    expect(r.url).toBeInstanceOf(URL);
    expect(r.url.hostname).toBe('s3-us-west-2.amazonaws.com');
  });
});

describe('fetchValidated re-checks every redirect hop', () => {
  const mk = (status: number, location?: string) => ({
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location ?? null : null) },
  });

  it('returns the response directly on a 200', async () => {
    const fetchImpl = async () => mk(200);
    const out = await fetchValidated(new URL('https://good.example.org/x'), fetchImpl as never);
    expect(out.res?.status).toBe(200);
  });

  it('refuses a redirect that points at a private host', async () => {
    // Public URL, 302 → cloud metadata endpoint. redirect:'follow' would have
    // chased it; this must refuse.
    const fetchImpl = async () => mk(302, 'https://169.254.169.254/latest/meta-data/');
    const out = await fetchValidated(new URL('https://good.example.org/x'), fetchImpl as never);
    expect(out.res).toBeUndefined();
    expect(out.problem).toMatch(/redirect to host .*169\.254\.169\.254/);
  });

  it('follows a redirect to another public host and re-validates it', async () => {
    let hop = 0;
    const fetchImpl = async () => (hop++ === 0 ? mk(301, 'https://cdn.example.org/file') : mk(200));
    const out = await fetchValidated(new URL('https://good.example.org/x'), fetchImpl as never);
    expect(out.res?.status).toBe(200);
    expect(hop).toBe(2);
  });

  it('gives up after too many redirects rather than looping', async () => {
    const fetchImpl = async () => mk(302, 'https://good.example.org/again');
    const out = await fetchValidated(new URL('https://good.example.org/x'), fetchImpl as never, 3);
    expect(out.problem).toMatch(/too many redirects/);
  });
});
