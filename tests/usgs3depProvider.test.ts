/**
 * usgs3depProvider.test.ts
 *
 * Contract tests for the USGS 3DEP provider. We exercise the surface
 * with a fake `fetch` so the test suite stays Node-pure and offline.
 *
 * What we verify
 * ──────────────
 * 1. Coarse coverage gating — domestic US bboxes pass, international
 *    bboxes get short-circuited with `no-coverage` before any HTTP
 *    happens.
 * 2. URL construction — the request honours the TNM Products bbox /
 *    dataset / format contract.
 * 3. Response parsing — COPC-suffixed downloadURLs become tiles; non-
 *    COPC items are filtered out.
 * 4. Error mapping — TypeError → 'cors', AbortError → 'timeout',
 *    HTTP 429 → 'rate-limited', malformed body → 'malformed-response'.
 */

import { describe, it, expect } from 'vitest';
import { Usgs3depProvider, type LatLonBbox } from '../src/io/catalog';

const CONUS_BBOX: LatLonBbox = [-122.45, 37.75, -122.4, 37.8]; // San Francisco
const FRANCE_BBOX: LatLonBbox = [2.0, 48.5, 2.5, 49.0]; // Paris

function makeJsonResponse(body: unknown, init?: Partial<ResponseInit>): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Usgs3depProvider — coarse coverage', () => {
  it('claims coverage for the contiguous United States', () => {
    const provider = new Usgs3depProvider();
    expect(provider.coarseCoverage(CONUS_BBOX)).toBe(true);
  });

  it('claims coverage for Alaska', () => {
    const provider = new Usgs3depProvider();
    expect(provider.coarseCoverage([-150, 60, -149, 61])).toBe(true);
  });

  it('does not claim coverage for France', () => {
    const provider = new Usgs3depProvider();
    expect(provider.coarseCoverage(FRANCE_BBOX)).toBe(false);
  });

  it('short-circuits to no-coverage without an HTTP call for non-US bboxes', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return makeJsonResponse({ items: [] });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(FRANCE_BBOX);
    expect(called).toBe(false);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('no-coverage');
  });
});

describe('Usgs3depProvider — request construction', () => {
  it('builds a TNM URL with bbox, dataset and JSON output', async () => {
    let seenUrl: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seenUrl = typeof input === 'string' ? input : input.toString();
      return makeJsonResponse({ items: [] });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    await provider.query(CONUS_BBOX);
    expect(seenUrl).toBeDefined();
    const url = new URL(seenUrl ?? '');
    expect(url.host).toBe('tnmaccess.nationalmap.gov');
    expect(url.searchParams.get('datasets')).toBe('Lidar Point Cloud (LPC)');
    expect(url.searchParams.get('outputFormat')).toBe('JSON');
    expect(url.searchParams.get('bbox')).toBe(
      '-122.450000,37.750000,-122.400000,37.800000',
    );
  });
});

describe('Usgs3depProvider — response parsing', () => {
  it('maps TNM items with a .copc.laz downloadLazURL into tiles', async () => {
    const tnmBody = {
      items: [
        {
          title: 'USGS_LPC_CA_SanFrancisco_2020',
          downloadLazURL:
            'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/Projects/CA_SanFrancisco_2020/tile_001.copc.laz',
          boundingBox: { minX: -122.45, minY: 37.75, maxX: -122.4, maxY: 37.8 },
          sizeInBytes: 250_000_000,
          publicationDate: '2020-06-15',
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.tiles.length).toBe(1);
      const tile = outcome.result.tiles[0];
      expect(tile?.format).toBe('copc');
      expect(tile?.streamUrl.endsWith('.copc.laz')).toBe(true);
      expect(tile?.acquisitionYear).toBe(2020);
      expect(tile?.attribution).toContain('Geological Survey');
      expect(outcome.result.estimatedBytes).toBe(250_000_000);
    }
  });

  it('filters out non-COPC LAZ items', async () => {
    const tnmBody = {
      items: [
        {
          title: 'Legacy LAZ tile',
          downloadURL: 'https://prd-tnm.s3.amazonaws.com/legacy/tile.laz',
          boundingBox: { minX: -122.45, minY: 37.75, maxX: -122.4, maxY: 37.8 },
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('no-coverage');
  });

  it('drops items whose bbox does not intersect the query', async () => {
    const tnmBody = {
      items: [
        {
          title: 'Far away tile',
          downloadLazURL: 'https://prd-tnm.s3.amazonaws.com/far.copc.laz',
          boundingBox: { minX: -80, minY: 40, maxX: -79, maxY: 41 },
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
  });

  it('parses string-encoded boundingBox values (TNM mixed-mode response)', async () => {
    // Regression: TNM has historically encoded boundingBox fields as
    // either JSON numbers or quoted strings depending on the staged-
    // products path. A strict `typeof === 'number'` check used to drop
    // the string form silently, surfacing "no coverage" for real
    // coverage.
    const tnmBody = {
      items: [
        {
          title: 'String-encoded bbox',
          downloadLazURL:
            'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/string.copc.laz',
          boundingBox: {
            minX: '-122.45',
            minY: '37.75',
            maxX: '-122.4',
            maxY: '37.8',
          },
          sizeInBytes: '12345678',
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.tiles.length).toBe(1);
      expect(outcome.result.estimatedBytes).toBe(12345678);
    }
  });

  it('keeps tiles whose bbox edge exactly touches the query (tile-seam case)', async () => {
    // Regression: a tile whose maxX equals the query's minX still
    // intersects geometrically — rejecting these dropped legitimate
    // neighbouring tiles at every seam.
    const tnmBody = {
      items: [
        {
          title: 'Seam tile',
          downloadLazURL: 'https://prd-tnm.s3.amazonaws.com/seam.copc.laz',
          boundingBox: { minX: -122.5, minY: 37.7, maxX: -122.45, maxY: 37.75 },
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query([-122.45, 37.75, -122.4, 37.8]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.tiles.length).toBe(1);
  });

  it('caps the result list at the documented maximum', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      title: `tile_${i}`,
      downloadLazURL: `https://prd-tnm.s3.amazonaws.com/t${i}.copc.laz`,
      boundingBox: { minX: -122.45, minY: 37.75, maxX: -122.4, maxY: 37.8 },
    }));
    const fetchImpl = (async () => makeJsonResponse({ items })) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.tiles.length).toBeLessThanOrEqual(25);
  });
});

describe('Usgs3depProvider — error mapping', () => {
  it('maps HTTP 429 into rate-limited', async () => {
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429 })) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('rate-limited');
  });

  it('maps a malformed JSON body into malformed-response', async () => {
    const fetchImpl = (async () =>
      new Response('not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('malformed-response');
  });

  it('maps a TypeError from fetch into cors', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('cors');
  });

  it('maps an AbortError into timeout', async () => {
    const fetchImpl = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('timeout');
  });

  it('honours an outer AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return makeJsonResponse({ items: [] });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX, { signal: controller.signal });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('timeout');
  });
});

describe('Usgs3depProvider — retry + transient resilience', () => {
  it('retries once on transient timeout and succeeds on the second attempt', async () => {
    // Regression for the v0.3.6 user-reported "timeout in Tucson" bug.
    // Before this change, an 8 s default tripped on TNM-under-load and
    // the user saw "no tiles available — timeout" with no recourse.
    // The provider now retries one time on its own internal timeout
    // (but NOT on outer-signal aborts, CORS, or 4xx).
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts === 1) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return makeJsonResponse({
        items: [
          {
            title: 'Retried hit',
            downloadLazURL:
              'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/retry.copc.laz',
            boundingBox: { minX: -122.45, minY: 37.75, maxX: -122.4, maxY: 37.8 },
          },
        ],
      });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(attempts).toBe(2);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.tiles.length).toBe(1);
  });

  it('does NOT retry when the outer signal is the source of the abort', async () => {
    // Regression: an outer-signal abort means the user cancelled
    // (e.g. typed a new search before the first resolved). A retry
    // would burn another 25 s on a query the user no longer wants.
    const controller = new AbortController();
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      // Abort the outer signal mid-fetch on attempt 1.
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX, {
      signal: controller.signal,
    });
    expect(attempts).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('timeout');
  });

  it('retries once on a transient 5xx', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts === 1) {
        return new Response('upstream error', { status: 503 });
      }
      return makeJsonResponse({
        items: [
          {
            title: 'Recovered',
            downloadLazURL:
              'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/LPC/ok.copc.laz',
            boundingBox: { minX: -122.45, minY: 37.75, maxX: -122.4, maxY: 37.8 },
          },
        ],
      });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(attempts).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  it('does NOT retry on CORS — would burn another 25 s on a never-success', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(attempts).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe('cors');
  });
});

describe('Usgs3depProvider — legacy-LAZ vs no-coverage messaging', () => {
  it('distinguishes "LAZ exists but not COPC-staged" from "no coverage at all"', async () => {
    // Three TNM items for the user's bbox, all plain LAZ (none staged
    // as COPC). The provider should surface this as no-coverage but
    // include the count in the message so the user knows USGS has
    // data here — it's just not browser-streamable yet.
    const tnmBody = {
      items: [
        {
          title: 'USGS LPC AZ Pima 2019 (legacy LAZ)',
          downloadLazURL: 'https://prd-tnm.s3.amazonaws.com/legacy/tile_a.laz',
          boundingBox: { minX: -110.85, minY: 32.20, maxX: -110.84, maxY: 32.21 },
        },
        {
          title: 'USGS LPC AZ Pima 2020 (legacy LAZ)',
          downloadLazURL: 'https://prd-tnm.s3.amazonaws.com/legacy/tile_b.laz',
          boundingBox: { minX: -110.85, minY: 32.20, maxX: -110.84, maxY: 32.21 },
        },
        {
          title: 'USGS LPC AZ Pima 2021 (legacy LAZ)',
          downloadURL: 'https://prd-tnm.s3.amazonaws.com/legacy/tile_c.laz',
          boundingBox: { minX: -110.85, minY: 32.20, maxX: -110.84, maxY: 32.21 },
        },
      ],
    };
    const fetchImpl = (async () => makeJsonResponse(tnmBody)) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query([-110.85, 32.20, -110.84, 32.21]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('no-coverage');
      expect(outcome.error.message).toContain('3');
      expect(outcome.error.message).toMatch(/COPC/);
      expect(outcome.error.message).toMatch(/migration is ongoing/i);
    }
  });

  it('returns the "no LiDAR at all" message when TNM returns zero items', async () => {
    const fetchImpl = (async () => makeJsonResponse({ items: [] })) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    const outcome = await provider.query(CONUS_BBOX);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe('no-coverage');
      expect(outcome.error.message).toMatch(/no LiDAR coverage/i);
      expect(outcome.error.message).not.toMatch(/migration is ongoing/i);
    }
  });
});

describe('Usgs3depProvider — TNM URL params', () => {
  it('includes prodFormats=LAZ to filter the server-side payload', async () => {
    let seenUrl: string | undefined;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seenUrl = typeof input === 'string' ? input : input.toString();
      return makeJsonResponse({ items: [] });
    }) as typeof fetch;
    const provider = new Usgs3depProvider({ fetchImpl });
    await provider.query(CONUS_BBOX);
    expect(seenUrl).toBeDefined();
    const url = new URL(seenUrl ?? '');
    expect(url.searchParams.get('prodFormats')).toBe('LAZ');
  });
});
