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

describe('checkUrl', () => {
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
