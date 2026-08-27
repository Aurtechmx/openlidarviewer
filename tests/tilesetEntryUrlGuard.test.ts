/**
 * tilesetEntryUrlGuard.test.ts — the entry URL is the root of every trust
 * decision under it.
 *
 * Tile URLs are validated against a base derived from the entry, and part of
 * that check is that a tile stays on the entry's own origin. So an unchecked
 * entry does not merely go unvalidated itself: it hands every tile below it an
 * origin that then passes the same-origin test. Validating tile URLs while
 * leaving the entry open is a fix with a hole in the middle of it.
 *
 * `validateRemoteTilesetUrl` existed the whole time and had exactly one caller,
 * in the merged reader that the streaming path replaced. Nothing upstream
 * covers it: the router only pattern-matches a path ending in `tileset.json`.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRemoteTileset, TilesetRefusal } from '../src/app/openTilesetLayer';
import { validateRemoteTilesetUrl } from '../src/io/tiles3d/tilesetUrl';
import { isTilesetEntryUrl } from '../src/app/openStreaming';

/** Deps that fail loudly if anything is fetched. */
function deps() {
  const fetched: string[] = [];
  return {
    fetched,
    d: {
      isLoading: () => false,
      setLoading: () => {},
      viewerReady: Promise.resolve(),
      getViewer: () => ({ clouds: () => [], attachStreamingCloud: vi.fn() }),
      getStreamingQuality: () => 'balanced',
      getStreamingBenchmark: () => null,
      isPhone: () => false,
      showToast: () => {},
      debug: false,
      closeStreaming: () => {},
      clearOpenStaticLayers: () => {},
      startStreamingStatusPolling: () => {},
      revealStreamingChrome: () => {},
      stage: { hideEmptyState: () => {} },
      inspectorCards: { refreshProvenanceFromStreaming: () => {} },
      crsCoordinator: { refreshCrsForStreamingCloud: () => {} },
      streamingPanel: {
        setColorModes: vi.fn(), setQuality: () => {}, setSourceUrl: () => {}, setPhase: () => {},
      },
      dropZone: {
        setOpening: () => {}, setCancelHandler: () => {}, setProgress: () => {}, setError: vi.fn(),
      },
    },
  };
}

const HOSTILE = [
  ['http://169.254.169.254/tileset.json', 'a cloud metadata address'],
  ['http://127.0.0.1:8080/tileset.json', 'localhost'],
  ['file:///etc/tileset.json', 'a local file'],
  ['http://[::1]/tileset.json', 'loopback over IPv6'],
] as const;

describe('the entry URL', () => {
  it.each(HOSTILE)('is refused: %s (%s)', (url) => {
    expect(validateRemoteTilesetUrl(url).ok).toBe(false);
  });

  it.each(HOSTILE)('reaches no fetch through the open: %s (%s)', async (url) => {
    const t = deps();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      t.fetched.push(String(input));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await openRemoteTileset(url, undefined, t.d as never);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(
      t.fetched,
      'the open fetched the entry document before deciding whether it was allowed to',
    ).toEqual([]);
    expect(t.d.dropZone.setError).toHaveBeenCalled();
  });

  it('the router alone does not decide this, it only matches the path', () => {
    // Pinned because "the router checked it" is the assumption that left the
    // entry unvalidated in the first place.
    expect(isTilesetEntryUrl('http://169.254.169.254/tileset.json')).toBe(true);
    expect(validateRemoteTilesetUrl('http://169.254.169.254/tileset.json').ok).toBe(false);
  });

  it('an ordinary https entry still opens', () => {
    expect(validateRemoteTilesetUrl('https://tiles.example.com/city/tileset.json').ok).toBe(true);
  });

  it('refuses a URL that is not a tileset entry point at all', () => {
    expect(validateRemoteTilesetUrl('https://tiles.example.com/city/').ok).toBe(false);
  });

  it('carries the refusal as one, so the reason reaches the user', () => {
    expect(new TilesetRefusal('x') instanceof Error).toBe(true);
  });
});
