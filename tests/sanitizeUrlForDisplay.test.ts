/**
 * sanitizeUrlForDisplay.test.ts
 *
 * Pins the credential-scrubbing contract: user/pass MUST be stripped,
 * AND the query string MUST be dropped because signed-URL schemes
 * (Azure SAS, AWS presigned, GCS signed URLs) carry the bearer token
 * in the query. The previous version stripped user/pass but left the
 * query — a working token could leak into error messages.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeUrlForDisplay } from '../src/io/range/RangeSource';

describe('sanitizeUrlForDisplay — credential scrubbing', () => {
  it('strips userinfo', () => {
    expect(sanitizeUrlForDisplay('https://user:pass@example.com/a.laz')).toBe(
      'https://example.com/a.laz',
    );
  });

  it('drops query parameters (where signed-URL tokens live)', () => {
    const sas =
      'https://acct.blob.core.windows.net/c/file.laz?sv=2024-01-01&sig=ABCDEF';
    const out = sanitizeUrlForDisplay(sas);
    expect(out).not.toContain('sig=');
    expect(out).not.toContain('sv=');
    expect(out).toContain('?…');
    expect(out).toContain('acct.blob.core.windows.net');
  });

  it('drops AWS presigned query', () => {
    const aws =
      'https://bucket.s3.amazonaws.com/key.laz?AWSAccessKeyId=AKIA&Signature=ABC';
    const out = sanitizeUrlForDisplay(aws);
    expect(out).not.toContain('AWSAccessKeyId');
    expect(out).not.toContain('Signature');
    expect(out).toContain('?…');
  });

  it('strips userinfo AND query in the same URL', () => {
    const out = sanitizeUrlForDisplay(
      'https://u:p@example.com/file.laz?token=secret',
    );
    expect(out).not.toContain('u:p');
    expect(out).not.toContain('secret');
    expect(out).toContain('?…');
  });

  it('leaves URLs without query or userinfo intact', () => {
    expect(sanitizeUrlForDisplay('https://example.com/clean.laz')).toBe(
      'https://example.com/clean.laz',
    );
  });

  it('scrubs malformed URLs via textual fallback', () => {
    // Missing scheme — URL parser will throw, fallback path applies.
    const out = sanitizeUrlForDisplay('not://valid url?token=secret');
    expect(out).not.toContain('secret');
  });

  it('handles a URL with an empty path', () => {
    expect(sanitizeUrlForDisplay('https://example.com?foo=bar')).toContain(
      '?…',
    );
    expect(sanitizeUrlForDisplay('https://example.com?foo=bar')).not.toContain(
      'foo=',
    );
  });

  it('preserves the path so the user can tell which file failed', () => {
    const out = sanitizeUrlForDisplay(
      'https://example.com/dir/file.copc.laz?sig=xyz',
    );
    expect(out).toContain('/dir/file.copc.laz');
  });
});
