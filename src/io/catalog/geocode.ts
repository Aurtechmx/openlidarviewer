/**
 * src/io/catalog/geocode.ts
 *
 * **EXPERIMENTAL — not wired into the v0.3.6 user flow.**
 *
 * This module is retained as scaffolding for a possible future
 * address-based catalog workflow. The shipped v0.3.6 empty-state UI
 * uses the curated picker in `src/io/catalog/curatedLocations.ts`,
 * which ships pre-verified URLs and fires no geocoder request. Nothing
 * in the active runtime imports `geocodeAddress`; tree-shaking drops
 * the implementation from the shell bundle.
 *
 * The address-search path was removed from the active UI because:
 *  - USGS TNM Products API surfaces only legacy non-streamable LAZ
 *    URLs for the bboxes we tested, so the address workflow returned
 *    tiles that wouldn't open.
 *  - Geocoder accuracy + 3DEP's incomplete COPC migration meant most
 *    addresses produced "no coverage" responses.
 *
 * If a future release adds a reliable provider that can return COPC
 * tiles by bbox (OpenTopography, AHN, IGN LiDAR HD, …), this module
 * is ready to supply the address→bbox step. Until then, treat it as
 * infrastructure-in-waiting, not user-facing functionality.
 *
 * Original docblock for reference
 * ───────────────────────────────
 * OpenStreetMap Nominatim integration. Given an address string, returns
 * a `GeocodeResult` with a centred lat/lon and a usable bbox. Sends ONE
 * plain-text query to nominatim.openstreetmap.org with no cookies, no
 * referer leak, and the standard Nominatim usage policy
 * (a self-identifying User-Agent header).
 */

import type { GeocodeOutcome, LatLon, LatLonBbox } from './types';

const NOMINATIM_API = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Per Nominatim usage policy, every request MUST include a
 * self-identifying User-Agent. Browsers won't let us override the
 * `User-Agent` header, but a `Referer` from the deployed origin
 * satisfies the policy in practice. We additionally set a
 * `Accept-Language` header so results match the user's locale.
 */
const DEFAULT_LANG_HEADER = 'en';

interface NominatimItem {
  readonly place_id?: number;
  readonly display_name?: string;
  readonly lat?: string;
  readonly lon?: string;
  /** boundingbox is `[south, north, west, east]` as strings. */
  readonly boundingbox?: readonly string[];
}

export interface GeocodeOptions {
  /** Override the Nominatim endpoint (useful in tests). */
  readonly endpoint?: string;
  /** Override the `fetch` implementation (useful in tests). */
  readonly fetchImpl?: typeof fetch;
  /** Override the per-query timeout. */
  readonly timeoutMs?: number;
  /** Locale tag for `Accept-Language`. */
  readonly language?: string;
  /** Optional outer signal — aborting cancels the lookup. */
  readonly signal?: AbortSignal;
}

function withTimeout(
  outer: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms);
  const onOuterAbort = (): void => {
    clearTimeout(timer);
    controller.abort(outer?.reason ?? new Error('aborted'));
  };
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onOuterAbort);
    },
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

function bboxFromNominatim(raw: readonly string[] | undefined): LatLonBbox | undefined {
  if (!Array.isArray(raw) || raw.length !== 4) return undefined;
  const south = parseNumber(raw[0]);
  const north = parseNumber(raw[1]);
  const west = parseNumber(raw[2]);
  const east = parseNumber(raw[3]);
  if (
    south === undefined ||
    north === undefined ||
    west === undefined ||
    east === undefined
  ) {
    return undefined;
  }
  if (south >= north || west >= east) return undefined;
  return [west, south, east, north];
}

function centerFromNominatim(item: NominatimItem): LatLon | undefined {
  const lat = parseNumber(item.lat);
  const lon = parseNumber(item.lon);
  if (lat === undefined || lon === undefined) return undefined;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  return { lat, lon };
}

/**
 * Geocode an address. Returns `ok: true` with the first viable hit;
 * returns `ok: false` with a typed `CatalogError` for the failure modes
 * the UI knows how to render.
 */
export async function geocodeAddress(
  query: string,
  options: GeocodeOptions = {},
): Promise<GeocodeOutcome> {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: {
        code: 'bad-geocode',
        message: 'Please enter an address or place name to search.',
      },
    };
  }

  const endpoint = options.endpoint ?? NOMINATIM_API;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const language = options.language ?? DEFAULT_LANG_HEADER;

  const url = new URL(endpoint);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '0');

  const { signal, cancel } = withTimeout(options.signal, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Language': language,
      },
      signal,
    });
  } catch (err) {
    cancel();
    if (err && typeof err === 'object' && 'name' in err) {
      const name = String((err as { name: unknown }).name);
      if (name === 'AbortError') {
        return {
          ok: false,
          error: { code: 'timeout', message: 'Address lookup timed out.' },
        };
      }
    }
    if (err instanceof TypeError) {
      return {
        ok: false,
        error: {
          code: 'cors',
          message:
            'Address lookup was blocked by the browser. This is usually a ' +
            'transient network issue — try again in a moment.',
        },
      };
    }
    const message = err instanceof Error ? err.message : 'Address lookup failed.';
    return { ok: false, error: { code: 'unknown', message } };
  }
  cancel();

  if (response.status === 429) {
    return {
      ok: false,
      error: {
        code: 'rate-limited',
        message:
          'Address lookup is rate-limiting requests. Please wait a moment and try again.',
      },
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'unknown',
        message: `Address lookup returned HTTP ${response.status}.`,
      },
    };
  }

  let items: readonly NominatimItem[];
  try {
    items = (await response.json()) as readonly NominatimItem[];
  } catch {
    return {
      ok: false,
      error: {
        code: 'malformed-response',
        message: 'Address lookup returned a body that could not be parsed.',
      },
    };
  }

  if (!Array.isArray(items) || items.length === 0) {
    return {
      ok: false,
      error: {
        code: 'bad-geocode',
        message: `No matches found for "${trimmed}". Try a more specific address.`,
      },
    };
  }

  const top = items[0];
  if (!top) {
    return {
      ok: false,
      error: {
        code: 'bad-geocode',
        message: `No matches found for "${trimmed}". Try a more specific address.`,
      },
    };
  }

  const center = centerFromNominatim(top);
  if (!center) {
    return {
      ok: false,
      error: {
        code: 'malformed-response',
        message: 'Address lookup returned a result without a usable location.',
      },
    };
  }

  const bbox =
    bboxFromNominatim(top.boundingbox) ?? bboxAroundPoint(center, 0.005);

  return {
    ok: true,
    result: {
      displayName: top.display_name?.trim() || trimmed,
      center,
      bbox,
    },
  };
}

/**
 * Build a small square bbox around a point. Used as a fallback when
 * the geocoder doesn't supply one, and as a building block for the UI
 * when the user clicks the map.
 *
 * `halfWidthDeg` defaults to ~0.005° (~500 m at the equator), a good
 * "look at this address" size for LiDAR tile selection.
 */
export function bboxAroundPoint(
  center: LatLon,
  halfWidthDeg = 0.005,
): LatLonBbox {
  const south = Math.max(-90, center.lat - halfWidthDeg);
  const north = Math.min(90, center.lat + halfWidthDeg);
  const west = Math.max(-180, center.lon - halfWidthDeg);
  const east = Math.min(180, center.lon + halfWidthDeg);
  return [west, south, east, north];
}
