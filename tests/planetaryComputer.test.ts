/**
 * planetaryComputer.test.ts
 *
 * Unit tests for the v0.3.6 Planetary Computer STAC client. Covers:
 *   • `parseFeatureCollection` — normalises a real-shape STAC payload,
 *     drops malformed features without throwing.
 *   • bbox validation — rejects malformed bboxes with a meaningful error.
 *   • EPSG short-circuit — `pcStacItemToCrsHint` returns the EPSG when
 *     present, null when absent.
 *   • `searchByBbox` happy path — encodes the request URL correctly and
 *     returns parsed items.
 *   • `searchByLatLon` — wraps the bbox path with the configured radius.
 *
 * All tests run in Node — the client takes a custom `fetcher` arg so we
 * stub `fetch` without touching the network.
 */

import { describe, it, expect } from 'vitest';
import {
  PLANETARY_COMPUTER_STAC,
  PLANETARY_COMPUTER_SAS,
  PC_COLLECTION_3DEP_COPC,
  PlanetaryComputerError,
  parseFeatureCollection,
  pcStacItemToCrsHint,
  searchByBbox,
  searchByLatLon,
  signAssetUrl,
  type BboxWGS84,
} from '../src/io/catalog/planetaryComputer';

// Real-shape STAC FeatureCollection abridged from the PC live response —
// two well-formed features + one malformed feature the parser must drop.
const SAMPLE_FC = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'usgs-3dep-co-2019-foothills-001',
      bbox: [-105.30, 40.00, -105.27, 40.03],
      properties: {
        title: 'Colorado Foothills 2019 — Tile 001',
        datetime: '2019-08-15T00:00:00Z',
        'proj:epsg': 26913,
        'pc:count': 12_400_000,
      },
      assets: {
        data: {
          href: 'https://example.org/3dep/co-foothills-2019/tile-001.copc.laz',
          type: 'application/vnd.laszip',
        },
      },
    },
    {
      type: 'Feature',
      id: 'usgs-3dep-or-2020-portland-007',
      bbox: [-122.70, 45.50, -122.55, 45.55],
      properties: {
        // No proj:epsg here — exercise the "epsg may be missing" branch.
        start_datetime: '2020-06-01T00:00:00Z',
        end_datetime: '2020-09-30T00:00:00Z',
        title: 'Portland 2020 — Tile 007',
      },
      assets: {
        copc: {
          href: 'https://example.org/3dep/or-portland-2020/tile-007.copc.laz',
        },
      },
    },
    // Malformed — missing bbox. Parser must drop, not throw.
    {
      type: 'Feature',
      id: 'malformed-no-bbox',
      properties: {},
      assets: { data: { href: 'https://example.org/whatever.copc.laz' } },
    },
    // Malformed — missing data asset. Parser must drop, not throw.
    {
      type: 'Feature',
      id: 'malformed-no-asset',
      bbox: [-100, 40, -99, 41],
      properties: {},
      assets: {},
    },
  ],
};

describe('parseFeatureCollection', () => {
  it('parses a well-formed FeatureCollection into normalised items', () => {
    const items = parseFeatureCollection(SAMPLE_FC);
    expect(items).toHaveLength(2);

    expect(items[0]).toMatchObject({
      id: 'usgs-3dep-co-2019-foothills-001',
      source: 'copc',
      assetUrl: 'https://example.org/3dep/co-foothills-2019/tile-001.copc.laz',
      bbox: [-105.30, 40.00, -105.27, 40.03],
      epsg: 26913,
      title: 'Colorado Foothills 2019 — Tile 001',
      pointCount: 12_400_000,
    });
    expect(items[0].datetime?.start).toBe('2019-08-15T00:00:00Z');

    expect(items[1]).toMatchObject({
      id: 'usgs-3dep-or-2020-portland-007',
      source: 'copc',
      assetUrl: 'https://example.org/3dep/or-portland-2020/tile-007.copc.laz',
    });
    // EPSG missing on the second feature — must be undefined, not 0.
    expect(items[1].epsg).toBeUndefined();
    // datetime range parses from start_datetime / end_datetime.
    expect(items[1].datetime).toEqual({
      start: '2020-06-01T00:00:00Z',
      end: '2020-09-30T00:00:00Z',
    });
  });

  it('returns an empty array for non-FeatureCollection payloads', () => {
    expect(parseFeatureCollection(null)).toEqual([]);
    expect(parseFeatureCollection({ type: 'Feature' })).toEqual([]);
    expect(parseFeatureCollection({ type: 'FeatureCollection' })).toEqual([]);
    expect(parseFeatureCollection('not-an-object')).toEqual([]);
  });

  it('drops malformed features (missing bbox, missing asset) without throwing', () => {
    const items = parseFeatureCollection(SAMPLE_FC);
    expect(items.find((i) => i.id === 'malformed-no-bbox')).toBeUndefined();
    expect(items.find((i) => i.id === 'malformed-no-asset')).toBeUndefined();
  });

  it('accepts 6-tuple bboxes (with elevation) and ignores the z extent', () => {
    const fc = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'three-d-bbox',
          bbox: [-105.30, 40.00, 0, -105.27, 40.03, 100],
          properties: { 'proj:epsg': 26913 },
          assets: { data: { href: 'https://example.org/a.copc.laz' } },
        },
      ],
    };
    const items = parseFeatureCollection(fc);
    expect(items).toHaveLength(1);
    expect(items[0].bbox).toEqual([-105.30, 40.00, -105.27, 40.03]);
  });
});

describe('pcStacItemToCrsHint', () => {
  it('extracts the EPSG when present', () => {
    const items = parseFeatureCollection(SAMPLE_FC);
    const hint = pcStacItemToCrsHint(items[0]);
    expect(hint).toEqual({ epsg: 26913, source: 'planetary-computer-stac' });
  });

  it('returns null when the item carries no EPSG', () => {
    const items = parseFeatureCollection(SAMPLE_FC);
    expect(pcStacItemToCrsHint(items[1])).toBeNull();
  });
});

describe('searchByBbox', () => {
  const bbox: BboxWGS84 = [-105.30, 40.00, -105.27, 40.03];

  it('builds the correct STAC URL and returns parsed items', async () => {
    let receivedUrl = '';
    const stub: typeof fetch = async (input) => {
      receivedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return new Response(JSON.stringify(SAMPLE_FC), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const items = await searchByBbox({ bbox, limit: 5 }, stub);
    expect(items).toHaveLength(2);
    expect(receivedUrl).toContain(`${PLANETARY_COMPUTER_STAC}/search?`);
    expect(receivedUrl).toContain(`collections=${PC_COLLECTION_3DEP_COPC}`);
    expect(receivedUrl).toContain('bbox=-105.3%2C40%2C-105.27%2C40.03');
    expect(receivedUrl).toContain('limit=5');
  });

  it('clamps limit to the 1..50 range', async () => {
    let receivedUrl = '';
    const stub: typeof fetch = async (input) => {
      receivedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    await searchByBbox({ bbox, limit: 999 }, stub);
    expect(receivedUrl).toContain('limit=50');
    await searchByBbox({ bbox, limit: 0 }, stub);
    expect(receivedUrl).toContain('limit=1');
  });

  it('throws PlanetaryComputerError on non-2xx response, with status code', async () => {
    const stub: typeof fetch = async () =>
      new Response('not found', { status: 404 });
    await expect(searchByBbox({ bbox }, stub)).rejects.toMatchObject({
      name: 'PlanetaryComputerError',
      status: 404,
    });
  });

  it('throws PlanetaryComputerError on invalid JSON', async () => {
    const stub: typeof fetch = async () =>
      new Response('not-json-at-all', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    await expect(searchByBbox({ bbox }, stub)).rejects.toBeInstanceOf(
      PlanetaryComputerError,
    );
  });

  it('rejects malformed bboxes with a descriptive error', async () => {
    const stub: typeof fetch = async () => new Response('', { status: 200 });
    await expect(
      searchByBbox({ bbox: [10, 10, 5, 5] as BboxWGS84 }, stub),
    ).rejects.toThrow(/west.*east/i);
    await expect(
      searchByBbox({ bbox: [-200, 0, 200, 1] as BboxWGS84 }, stub),
    ).rejects.toThrow(/WGS84/);
  });

  it('propagates AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const stub: typeof fetch = async (_input, init) => {
      // Mimic real fetch behaviour — throw AbortError when the signal fires.
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const promise = searchByBbox({ bbox, signal: controller.signal }, stub);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('signAssetUrl', () => {
  const rawHref = 'https://pceo.blob.core.windows.net/3dep/tile.copc.laz';
  const signedHref = 'https://pceo.blob.core.windows.net/3dep/tile.copc.laz?sv=2024-08-04&sig=abc123';

  it('hits the SAS /sign endpoint with the href query param', async () => {
    let receivedUrl = '';
    const stub: typeof fetch = async (input) => {
      receivedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return new Response(
        JSON.stringify({ href: signedHref, 'msft:expiry': '2026-12-31T23:59:59Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const result = await signAssetUrl(rawHref, stub);
    expect(result).toBe(signedHref);
    expect(receivedUrl).toContain(`${PLANETARY_COMPUTER_SAS}/sign?`);
    // The raw href travels URL-encoded; both `:` and `/` are encoded.
    expect(receivedUrl).toContain('href=https%3A%2F%2Fpceo.blob.core.windows.net');
  });

  it('throws PlanetaryComputerError when the SAS endpoint returns a non-2xx', async () => {
    const stub: typeof fetch = async () =>
      new Response('upstream failure', { status: 503 });
    await expect(signAssetUrl(rawHref, stub)).rejects.toMatchObject({
      name: 'PlanetaryComputerError',
      status: 503,
    });
  });

  it('throws when the response is missing the href field', async () => {
    const stub: typeof fetch = async () =>
      new Response(JSON.stringify({ 'msft:expiry': '2026-12-31T23:59:59Z' }), {
        status: 200,
      });
    await expect(signAssetUrl(rawHref, stub)).rejects.toThrow(/href/i);
  });

  it('throws on empty input rather than hitting the network', async () => {
    let called = false;
    const stub: typeof fetch = async () => {
      called = true;
      return new Response('', { status: 200 });
    };
    await expect(signAssetUrl('', stub)).rejects.toThrow(/empty/i);
    expect(called).toBe(false);
  });

  it('propagates AbortError when the signal aborts', async () => {
    const controller = new AbortController();
    const stub: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const promise = signAssetUrl(rawHref, stub, controller.signal);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('searchByLatLon', () => {
  it('expands the point to a default 0.05° square bbox', async () => {
    let receivedUrl = '';
    const stub: typeof fetch = async (input) => {
      receivedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
      });
    };
    await searchByLatLon({ lat: 40.0, lon: -105.27 }, stub);
    // bbox=lon-r,lat-r,lon+r,lat+r  with r=0.05
    expect(receivedUrl).toMatch(/bbox=-105\.32%2C39\.95%2C-105\.22%2C40\.05/);
  });

  it('honours a custom radius', async () => {
    let receivedUrl = '';
    const stub: typeof fetch = async (input) => {
      receivedUrl = typeof input === 'string' ? input : (input as Request).url ?? '';
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
        status: 200,
      });
    };
    await searchByLatLon({ lat: 0, lon: 0, radiusDeg: 1.0 }, stub);
    expect(receivedUrl).toMatch(/bbox=-1%2C-1%2C1%2C1/);
  });
});
