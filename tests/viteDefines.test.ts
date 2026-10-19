import { describe, expect, it } from 'vitest';
import { parseEmbedOrigins, testSeamEnabled } from '../scripts/lib/viteDefines.mjs';

describe('testSeamEnabled', () => {
  it('is on for the dev server, whatever the environment says', () => {
    expect(testSeamEnabled('development', {})).toBe(true);
  });

  it('is on for a plain build only when OLV_TEST_SEAM=1 asks', () => {
    expect(testSeamEnabled('production', {})).toBe(false);
    expect(testSeamEnabled('production', { OLV_TEST_SEAM: '0' })).toBe(false);
    expect(testSeamEnabled('production', { OLV_TEST_SEAM: '1' })).toBe(true);
  });

  it('is never on for the live build, even with OLV_TEST_SEAM=1 exported', () => {
    expect(testSeamEnabled('live', { OLV_TEST_SEAM: '1' })).toBe(false);
    expect(testSeamEnabled('live', {})).toBe(false);
  });
});

describe('parseEmbedOrigins', () => {
  it('is empty by default', () => {
    expect(parseEmbedOrigins(undefined)).toEqual({ origins: [], dropped: [] });
    expect(parseEmbedOrigins('')).toEqual({ origins: [], dropped: [] });
  });

  it('reduces each entry to its origin and drops duplicates', () => {
    expect(parseEmbedOrigins('https://a.example/x, https://A.example, http://b.example:8080').origins).toEqual([
      'https://a.example',
      'http://b.example:8080',
    ]);
  });

  it('drops wildcards, bare hosts and non-http schemes, and reports them', () => {
    expect(parseEmbedOrigins('*,portal.example,javascript:alert(1),https://ok.example')).toEqual({
      origins: ['https://ok.example'],
      dropped: ['*', 'portal.example', 'javascript:alert(1)'],
    });
  });
});
