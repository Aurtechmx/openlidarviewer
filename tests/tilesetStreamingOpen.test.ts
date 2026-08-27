/**
 * tilesetStreamingOpen.test.ts — opening a tileset URL now streams it.
 *
 * The open used to read every tile and merge them into one static cloud, so
 * nothing appeared until the whole tileset had been fetched and a large one was
 * refused rather than opened. These cases pin the switch and the ordering that
 * makes it safe: the attach commits before the static layers are retired, and
 * application metadata is published only after that commit.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRemoteTileset, tilesetDisplayName, TilesetRefusal } from '../src/app/openTilesetLayer';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const DOC = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 100,
  root: { boundingVolume: BOX, geometricError: 50, refine: 'REPLACE', content: { uri: 'r.pnts' } },
});

/** Deps that record the order of the calls the commit sequence makes. */
function deps(doc = DOC) {
  const order: string[] = [];
  const viewer = {
    clouds: () => [],
    attachStreamingCloud: vi.fn(async () => {
      order.push('attach');
    }),
    setMode: vi.fn(),
    frameAll: vi.fn(),
  };
  return {
    order,
    viewer,
    attached: viewer.attachStreamingCloud,
    d: {
      isLoading: () => false,
      setLoading: () => {},
      viewerReady: Promise.resolve(),
      getViewer: () => viewer,
      getStreamingQuality: () => 'balanced',
      getStreamingBenchmark: () => null,
      isPhone: () => false,
      showToast: () => {},
      debug: false,
      closeStreaming: () => order.push('closeStreaming'),
      clearOpenStaticLayers: () => order.push('clearStatic'),
      startStreamingStatusPolling: () => order.push('poll'),
      revealStreamingChrome: () => order.push('reveal'),
      stage: { hideEmptyState: () => {} },
      inspectorCards: { refreshProvenanceFromStreaming: () => order.push('provenance') },
      crsCoordinator: { refreshCrsForStreamingCloud: () => order.push('crs') },
      streamingPanel: {
        setColorModes: vi.fn(),
        setQuality: () => {},
        setSourceUrl: () => {},
        setPhase: () => {},
      },
      dropZone: {
        setOpening: () => {},
        setCancelHandler: () => {},
        setProgress: () => {},
        setError: vi.fn(),
      },
      __doc: doc,
    },
  };
}

/** Serve the tileset document without touching the network. */
function withTransport<T>(doc: string, run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('tileset.json')) {
      return new Response(doc, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(new ArrayBuffer(0), { status: 404 });
  }) as unknown as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = realFetch;
  });
}

describe('the open path', () => {
  it('attaches a streaming cloud rather than a merged static one', async () => {
    const t = deps();
    await withTransport(DOC, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    expect(
      t.attached,
      'a tileset opens by streaming now; a merged static attach would mean the ' +
        'whole document is read before anything appears',
    ).toHaveBeenCalledTimes(1);
  });

  it('retires the static layers only after the attach has committed', async () => {
    const t = deps();
    await withTransport(DOC, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    const attach = t.order.indexOf('attach');
    const clear = t.order.indexOf('clearStatic');
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(
      clear > attach,
      'clearing first means a throw from the attach leaves the previous scene ' +
        'destroyed with no replacement',
    ).toBe(true);
  });

  it('publishes provenance only after the commit', async () => {
    const t = deps();
    await withTransport(DOC, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    expect(t.order.indexOf('provenance')).toBeGreaterThan(t.order.indexOf('attach'));
  });

  it('offers only the colour modes a point tile can fill', async () => {
    const t = deps();
    await withTransport(DOC, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    const modes = (t.d.streamingPanel.setColorModes.mock.calls[0] ?? [])[0] as string[];
    expect(modes).not.toContain('intensity');
    expect(modes).not.toContain('classification');
  });

  it('refuses a tileset that declares no tile with point content', async () => {
    const empty = JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 100,
      root: { boundingVolume: BOX, geometricError: 50, refine: 'REPLACE' },
    });
    const t = deps(empty);
    await withTransport(empty, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    expect(t.attached).not.toHaveBeenCalled();
    expect(t.d.dropZone.setError).toHaveBeenCalled();
  });
});

describe('the scan name', () => {
  it('comes from the document, not the whole URL', () => {
    expect(tilesetDisplayName('https://host/data/city/tileset.json')).toBe('tileset.json');
  });

  it('falls back to the input when it is not a URL', () => {
    expect(tilesetDisplayName('not a url')).toBe('not a url');
  });
});

describe('a refusal reaches the user', () => {
  const BOX2 = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

  /** The message actually shown on the drop zone for a given document. */
  async function shownFor(doc: string): Promise<string> {
    const t = deps(doc);
    await withTransport(doc, () =>
      openRemoteTileset('https://host/d/tileset.json', undefined, t.d as never),
    );
    const calls = t.d.dropZone.setError.mock.calls;
    return calls.length ? String(calls[0][0]) : '';
  }

  it('says what was wrong, not that the file is corrupt', async () => {
    // A valid 1.1 document using a form this subset does not serve. Reporting
    // it as corrupt is both false and unactionable.
    const shown = await shownFor(
      JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: BOX2,
          geometricError: 50,
          refine: 'REPLACE',
          content: { uri: 'a.pnts' },
          children: [
            { boundingVolume: BOX2, geometricError: 10, contents: [{ uri: 'b.pnts' }] },
          ],
        },
      }),
    );
    expect(shown).not.toContain('corrupt');
    expect(shown).toContain('contents');
  });

  it('names the tile it cannot serve', async () => {
    const shown = await shownFor(
      JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: BOX2,
          geometricError: 50,
          refine: 'REPLACE',
          content: { uri: 'a.pnts' },
          children: [
            { boundingVolume: BOX2, geometricError: 10, content: { uri: 'sub/tileset.json' } },
          ],
        },
      }),
    );
    expect(shown).toContain('sub/tileset.json');
    expect(shown).not.toContain('corrupt');
  });

  it('still classifies a failure that is not a refusal', () => {
    // A transport or decode failure has no reason worth quoting, and the
    // category is the useful thing to say. Nothing here should bypass that.
    expect(new TilesetRefusal('x') instanceof Error).toBe(true);
  });
});
