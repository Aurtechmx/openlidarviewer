/**
 * tiles3dTilesetUrl.test.ts — the URL guard for a remote 3D Tiles entry and
 * for the content URIs the entry document names.
 *
 * A tileset.json is remote input whose CONTENT names more URLs to fetch, which
 * is the whole reason this module exists separately from `eptUrls.ts`. So the
 * cases below are mostly hostile documents rather than malformed ones: a
 * content URI that leaves the host, one that walks up out of the tileset's own
 * directory, one that swaps the scheme for `data:`, and one that hides the host
 * change behind a protocol-relative form.
 */

import { describe, expect, test } from 'vitest';
import {
  isTilesetUrl,
  resolveTilesetContentUrl,
  tilesetBaseUrl,
  tilesetUrlSearch,
  validateRemoteTilesetUrl,
  MAX_CONTENT_URI_LENGTH,
} from '../src/io/tiles3d/tilesetUrl';

const BASE = 'https://tiles.example.org/scan/a/';

describe('isTilesetUrl', () => {
  test('recognises a tileset entry, with or without a query', () => {
    expect(isTilesetUrl('https://h.example/x/tileset.json')).toBe(true);
    expect(isTilesetUrl('https://h.example/x/tileset.json?token=abc')).toBe(true);
  });

  test('does not claim an ept.json or a bare directory', () => {
    expect(isTilesetUrl('https://h.example/x/ept.json')).toBe(false);
    expect(isTilesetUrl('https://h.example/x/')).toBe(false);
    expect(isTilesetUrl('https://h.example/x/subtileset.json')).toBe(false);
  });
});

describe('validateRemoteTilesetUrl', () => {
  test('accepts a plain https tileset URL and returns it unchanged', () => {
    const r = validateRemoteTilesetUrl('https://tiles.example.org/scan/a/tileset.json');
    expect(r).toEqual({ ok: true, url: 'https://tiles.example.org/scan/a/tileset.json' });
  });

  test('refuses a non-tileset path', () => {
    const r = validateRemoteTilesetUrl('https://tiles.example.org/scan/a/ept.json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tileset\.json/);
  });

  test('refuses a private-network host through the shared SSRF block-list', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '169.254.169.254', 'svc.internal']) {
      const r = validateRemoteTilesetUrl(`http://${host}/tileset.json`);
      expect(r.ok, host).toBe(false);
    }
  });

  test('refuses a non-http scheme and embedded credentials', () => {
    expect(validateRemoteTilesetUrl('file:///tmp/tileset.json').ok).toBe(false);
    expect(validateRemoteTilesetUrl('https://u:p@h.example/tileset.json').ok).toBe(false);
  });
});

describe('tilesetBaseUrl / tilesetUrlSearch', () => {
  test('the base is the entry directory, query and fragment dropped', () => {
    expect(tilesetBaseUrl('https://h.example/a/b/tileset.json?t=1#f')).toBe(
      'https://h.example/a/b/',
    );
  });

  test('the query is carried separately so a signed dataset keeps its credential', () => {
    expect(tilesetUrlSearch('https://h.example/a/tileset.json?sig=xyz')).toBe('?sig=xyz');
    expect(tilesetUrlSearch('https://h.example/a/tileset.json')).toBe('');
  });
});

describe('resolveTilesetContentUrl — what it accepts', () => {
  test('a relative URI resolves under the tileset directory', () => {
    expect(resolveTilesetContentUrl(BASE, 'tiles/0.pnts')).toEqual({
      ok: true,
      url: 'https://tiles.example.org/scan/a/tiles/0.pnts',
    });
  });

  test('the entry query rides derived requests', () => {
    const r = resolveTilesetContentUrl(BASE, '0.pnts', '?sig=xyz');
    expect(r).toEqual({ ok: true, url: 'https://tiles.example.org/scan/a/0.pnts?sig=xyz' });
  });

  test("an authored query is not replaced by the entry's", () => {
    const r = resolveTilesetContentUrl(BASE, '0.pnts?v=2', '?sig=xyz');
    expect(r).toEqual({ ok: true, url: 'https://tiles.example.org/scan/a/0.pnts?v=2' });
  });

  test('a same-directory absolute URL is accepted', () => {
    const r = resolveTilesetContentUrl(BASE, 'https://tiles.example.org/scan/a/deep/0.pnts');
    expect(r.ok).toBe(true);
  });
});

describe('resolveTilesetContentUrl — what it refuses', () => {
  test('an absolute URI naming another host', () => {
    const r = resolveTilesetContentUrl(BASE, 'https://evil.example/collect.pnts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the tileset's own host/);
  });

  test('a protocol-relative URI, which hides the host change', () => {
    const r = resolveTilesetContentUrl(BASE, '//evil.example/x.pnts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the tileset's own host/);
  });

  test('a private-network host reached from a public tileset', () => {
    const r = resolveTilesetContentUrl(BASE, 'http://169.254.169.254/latest/meta-data');
    expect(r.ok).toBe(false);
  });

  test('a `..` walk out of the tileset directory, on the same host', () => {
    const r = resolveTilesetContentUrl(BASE, '../../secrets/0.pnts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escapes the tileset directory/);
  });

  test('a root-relative URI landing on a sibling prefix', () => {
    const r = resolveTilesetContentUrl(BASE, '/scan/b/0.pnts');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/escapes the tileset directory/);
  });

  test('a non-http scheme', () => {
    for (const uri of ['data:application/octet-stream;base64,AAAA', 'javascript:alert(1)', 'file:///etc/passwd']) {
      expect(resolveTilesetContentUrl(BASE, uri).ok, uri).toBe(false);
    }
  });

  test('embedded credentials on the content URI', () => {
    const r = resolveTilesetContentUrl(BASE, 'https://u:p@tiles.example.org/scan/a/0.pnts');
    expect(r.ok).toBe(false);
  });

  test('an empty URI and one past the length ceiling', () => {
    expect(resolveTilesetContentUrl(BASE, '').ok).toBe(false);
    expect(resolveTilesetContentUrl(BASE, `${'a'.repeat(MAX_CONTENT_URI_LENGTH + 1)}.pnts`).ok).toBe(
      false,
    );
  });
});
