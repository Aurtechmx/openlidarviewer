/**
 * geocode.test.ts
 *
 * Contract tests for the Nominatim geocoder wrapper. Pure-data surface,
 * no DOM — we drive it with an injected `fetch`.
 */

import { describe, it, expect } from 'vitest';
import { geocodeAddress, bboxAroundPoint } from '../src/io/catalog';

function makeJsonResponse(body: unknown, init?: Partial<ResponseInit>): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('geocodeAddress — happy path', () => {
  it('parses a Nominatim hit into a centred lat/lon and bbox', async () => {
    const body = [
      {
        place_id: 1,
        display_name: '1600 Pennsylvania Ave NW, Washington, DC, USA',
        lat: '38.8977',
        lon: '-77.0365',
        boundingbox: ['38.8975', '38.8980', '-77.0368', '-77.0362'],
      },
    ];
    const fetchImpl = (async () => makeJsonResponse(body)) as typeof fetch;
    const outcome = await geocodeAddress('1600 Pennsylvania Ave', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.result) {
      expect(outcome.result.center.lat).toBeCloseTo(38.8977, 4);
      expect(outcome.result.center.lon).toBeCloseTo(-77.0365, 4);
      expect(outcome.result.bbox[0]).toBeCloseTo(-77.0368, 4);
      expect(outcome.result.bbox[3]).toBeCloseTo(38.898, 4);
      expect(outcome.result.displayName).toContain('Pennsylvania');
    }
  });

  it('falls back to a small square bbox when Nominatim omits boundingbox', async () => {
    const body = [
      {
        display_name: 'Somewhere',
        lat: '40.0',
        lon: '-100.0',
        // boundingbox omitted
      },
    ];
    const fetchImpl = (async () => makeJsonResponse(body)) as typeof fetch;
    const outcome = await geocodeAddress('Somewhere', { fetchImpl });
    expect(outcome.ok).toBe(true);
    if (outcome.ok && outcome.result) {
      const [w, s, e, n] = outcome.result.bbox;
      expect(w).toBeLessThan(e);
      expect(s).toBeLessThan(n);
      expect(e - w).toBeLessThan(0.05);
    }
  });
});

describe('geocodeAddress — error mapping', () => {
  it('returns bad-geocode for an empty query', async () => {
    const outcome = await geocodeAddress('  ');
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('bad-geocode');
  });

  it('returns bad-geocode for zero results', async () => {
    const fetchImpl = (async () => makeJsonResponse([])) as typeof fetch;
    const outcome = await geocodeAddress('asdfqwer', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('bad-geocode');
  });

  it('returns malformed-response for non-JSON', async () => {
    const fetchImpl = (async () =>
      new Response('boom', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const outcome = await geocodeAddress('anything', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('malformed-response');
  });

  it('returns malformed-response when the hit has no usable coordinates', async () => {
    const body = [{ display_name: 'broken', lat: 'NaN', lon: 'NaN' }];
    const fetchImpl = (async () => makeJsonResponse(body)) as typeof fetch;
    const outcome = await geocodeAddress('broken', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('malformed-response');
  });

  it('returns rate-limited for HTTP 429', async () => {
    const fetchImpl = (async () =>
      new Response('slow down', { status: 429 })) as typeof fetch;
    const outcome = await geocodeAddress('anywhere', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('rate-limited');
  });

  it('returns cors for a TypeError', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const outcome = await geocodeAddress('anywhere', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('cors');
  });

  it('returns timeout for an AbortError', async () => {
    const fetchImpl = (async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof fetch;
    const outcome = await geocodeAddress('anywhere', { fetchImpl });
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('timeout');
  });
});

describe('bboxAroundPoint', () => {
  it('produces a small square bbox around the point', () => {
    const bbox = bboxAroundPoint({ lat: 40, lon: -100 }, 0.01);
    expect(bbox[0]).toBeCloseTo(-100.01, 6);
    expect(bbox[1]).toBeCloseTo(39.99, 6);
    expect(bbox[2]).toBeCloseTo(-99.99, 6);
    expect(bbox[3]).toBeCloseTo(40.01, 6);
  });

  it('clamps to global lat/lon bounds', () => {
    const bbox = bboxAroundPoint({ lat: 89.999, lon: 179.999 }, 1);
    expect(bbox[1]).toBeGreaterThanOrEqual(-90);
    expect(bbox[3]).toBeLessThanOrEqual(90);
    expect(bbox[0]).toBeGreaterThanOrEqual(-180);
    expect(bbox[2]).toBeLessThanOrEqual(180);
  });
});
