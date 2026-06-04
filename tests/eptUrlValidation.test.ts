/**
 * eptUrlValidation.test.ts — v0.3.3 remote-UX polish.
 *
 * Tests the EPT-side mirrors of the COPC validator + error describer.
 * Critical-to-prove invariants: schema/credential filter is shared with
 * the COPC validator (so a future change there propagates), the
 * `/ept.json` suffix rule fires for paths missing it, and the error
 * describer pattern-matches the common failure shapes the EPT pipeline
 * will throw (parseEptMetadata reason, hierarchy/tile fetch failures,
 * CORS-like errors).
 */

import { describe, expect, test } from 'vitest';
import {
  validateRemoteEptUrl,
  describeRemoteEptError,
  MAX_REMOTE_EPT_URL_LENGTH,
} from '../src/io/ept/eptUrlValidation';

describe('validateRemoteEptUrl — happy path', () => {
  test('accepts a plain https URL ending in /ept.json', () => {
    const r = validateRemoteEptUrl('https://example.com/dataset/ept.json');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://example.com/dataset/ept.json');
  });
  test('accepts http (not just https)', () => {
    expect(validateRemoteEptUrl('http://data.example.com:8080/data/ept.json').ok).toBe(true);
  });
  test('accepts ept.json with a query string (e.g. CDN token)', () => {
    expect(
      validateRemoteEptUrl('https://example.com/dataset/ept.json?token=abc').ok,
    ).toBe(true);
  });
  test('accepts ept.json case-insensitively', () => {
    expect(validateRemoteEptUrl('https://example.com/dataset/EPT.json').ok).toBe(true);
  });
});

describe('validateRemoteEptUrl — rejection paths', () => {
  test('rejects empty / non-string input', () => {
    expect(validateRemoteEptUrl('').ok).toBe(false);
    // @ts-expect-error — runtime guard against non-string callers
    expect(validateRemoteEptUrl(null).ok).toBe(false);
  });
  test('rejects unparseable URLs', () => {
    expect(validateRemoteEptUrl('not-a-url').ok).toBe(false);
  });
  test('rejects non-http(s) schemes', () => {
    expect(validateRemoteEptUrl('file:///tmp/ept.json').ok).toBe(false);
    expect(validateRemoteEptUrl('ftp://example.com/ept.json').ok).toBe(false);
  });
  test('rejects localhost / private hosts (SSRF), even with a valid /ept.json path', () => {
    expect(validateRemoteEptUrl('http://localhost:8080/data/ept.json').ok).toBe(false);
    expect(validateRemoteEptUrl('http://192.168.0.10/data/ept.json').ok).toBe(false);
    expect(validateRemoteEptUrl('http://169.254.169.254/data/ept.json').ok).toBe(false);
  });
  test('rejects URLs with embedded credentials', () => {
    const r = validateRemoteEptUrl('https://user:pass@example.com/dataset/ept.json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/credentials/i);
  });
  test('rejects URLs over the length cap', () => {
    const long = 'https://example.com/' + 'a'.repeat(MAX_REMOTE_EPT_URL_LENGTH) + '/ept.json';
    const r = validateRemoteEptUrl(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/long|length|characters/i);
  });
  test('rejects URLs whose path does not end in /ept.json', () => {
    const r1 = validateRemoteEptUrl('https://example.com/dataset/data.json');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/ept\.json/i);
    const r2 = validateRemoteEptUrl('https://example.com/dataset/');
    expect(r2.ok).toBe(false);
    const r3 = validateRemoteEptUrl('https://example.com/scan.copc.laz');
    expect(r3.ok).toBe(false);
  });
});

describe('describeRemoteEptError — classification', () => {
  const URL = 'https://example.com/dataset/ept.json';

  test('CORS-like errors get the host-config message', () => {
    const msg = describeRemoteEptError(new Error('CORS policy blocked the request'), URL);
    expect(msg).toMatch(/CORS|Cross-Origin/i);
    expect(msg).toMatch(/cross-origin/i);
    expect(msg).toMatch(/example\.com/);
  });

  test('manifest 404 gets a precise "manifest not found" message', () => {
    const msg = describeRemoteEptError(
      new Error('EPT manifest fetch failed (404 Not Found).'),
      URL,
    );
    expect(msg).toMatch(/manifest not found|404/i);
    expect(msg).toMatch(/example\.com/);
  });

  test('manifest 5xx gets a "server-side error" message', () => {
    const msg = describeRemoteEptError(
      new Error('EPT manifest fetch failed (503 Service Unavailable).'),
      URL,
    );
    expect(msg).toMatch(/server-side error|try again/i);
  });

  test('parseEptMetadata reasons pass through verbatim', () => {
    const msg = describeRemoteEptError(
      new Error('Not a valid EPT manifest — schema missing X coordinate'),
      URL,
    );
    expect(msg).toMatch(/Not a valid EPT manifest/);
    expect(msg).toMatch(/schema missing X coordinate/);
  });

  test('hierarchy-fetch failures are surfaced with mid-load context', () => {
    const msg = describeRemoteEptError(
      new Error('EPT hierarchy fetch failed (500) for https://example.com/dataset/ept-hierarchy/3-1-2-0.json'),
      URL,
    );
    expect(msg).toMatch(/hierarchy/i);
    expect(msg).toMatch(/partially uploaded|directory layout/i);
  });

  test('tile-fetch failures get a retry-friendly message', () => {
    const msg = describeRemoteEptError(
      new Error('EPT tile fetch failed (500) for https://example.com/dataset/ept-data/4-1-2-0.laz'),
      URL,
    );
    expect(msg).toMatch(/tile|point-data/i);
    expect(msg).toMatch(/try again/i);
  });

  test('network-down errors get a host-unreachable message', () => {
    const msg = describeRemoteEptError(new TypeError('Failed to fetch'), URL);
    expect(msg).toMatch(/unreachable|host.*online/i);
  });

  test('fallback message anchors the URL host', () => {
    const msg = describeRemoteEptError(new Error('something unexpected'), URL);
    expect(msg).toMatch(/example\.com/);
    expect(msg).toMatch(/something unexpected/);
  });

  test('scrubs credentials from displayed URL', () => {
    const msg = describeRemoteEptError(
      new Error('something unexpected'),
      'https://user:pass@example.com/dataset/ept.json',
    );
    expect(msg).not.toMatch(/user:pass/);
    expect(msg).toMatch(/example\.com/);
  });
});
