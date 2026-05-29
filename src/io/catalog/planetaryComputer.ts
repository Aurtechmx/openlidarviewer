/**
 * planetaryComputer.ts
 *
 * Lazy-loaded STAC client for Microsoft Planetary Computer's public
 * `3dep-lidar-copc` catalog. Backs the v0.3.6 "Find LiDAR by location"
 * affordance below the curated dropdown.
 *
 * Inspired by `opengeos/maplibre-gl-usgs-lidar`'s STAC search path —
 * minus its MapLibre + basemap dependencies (we don't need a basemap to
 * search by bbox). The endpoint, query shape and proj-metadata short-
 * circuit are the directly-borrowed ideas.
 *
 * The client is intentionally tiny:
 *
 *   • `searchByBbox` — one fetch against the public STAC `/search`
 *     endpoint, GeoJSON FeatureCollection in, normalised PcStacItem[]
 *     out. Aborts cleanly via the optional `signal`.
 *   • `searchByLatLon` — wraps `searchByBbox` with a small radius so
 *     the UI can take a single point + zoom and get coverage.
 *   • `pcStacItemToCrsHint` — extracts `proj:epsg` from a STAC item so
 *     the streaming pipeline can preset the CRS *before* the LAS VLR
 *     probe, cutting ~500-700 ms off CRS-resolved time for PC sources.
 *
 * Pure — no DOM, no three.js. Tests live in `tests/planetaryComputer.test.ts`.
 *
 * Privacy contract — the endpoint is a public, unauthenticated STAC API
 * hosted by Microsoft Planetary Computer. The only request made on the
 * user's behalf is a bbox-scoped GET to the public catalog; no API key,
 * no personal identifier. The user gates the request explicitly by
 * typing a location and pressing Search; `?notelemetry=1` suppresses the
 * surface entirely. No PII leaves the device.
 */

/**
 * Public STAC search endpoint. Free, no auth, CORS-enabled. Documented
 * at https://planetarycomputer.microsoft.com/docs/concepts/sas/.
 */
export const PLANETARY_COMPUTER_STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
/**
 * SAS-signing endpoint. The STAC catalog returns bare Azure Blob URLs
 * that respond with HTTP 409 to direct range requests; Azure requires
 * a short-lived SAS token appended to the query string. The PC SAS API
 * mints one on demand from a public, unauthenticated endpoint and the
 * resulting URL is valid for ~1 hour — long enough for the streaming
 * pipeline to fetch every tile of a large COPC.
 *
 * Usage: GET `{PLANETARY_COMPUTER_SAS}/sign?href=<raw blob URL>`.
 * Response: `{ href: "<signed URL>", "msft:expiry": "<ISO timestamp>" }`.
 */
export const PLANETARY_COMPUTER_SAS = 'https://planetarycomputer.microsoft.com/api/sas/v1';
/** Collection id for USGS 3DEP LiDAR in COPC format. */
export const PC_COLLECTION_3DEP_COPC = '3dep-lidar-copc';

/** Six-tuple bbox: `[west, south, east, north]` per the GeoJSON/STAC convention. */
export type BboxWGS84 = readonly [number, number, number, number];

/**
 * One normalised STAC item — what the UI catalog row + streaming
 * dispatcher actually need. A superset of the maplibre-gl-usgs-lidar
 * plugin's shape; extra fields (`epsg`, `pointCount`) drive the CRS
 * short-circuit and the size budget hint.
 */
export interface PcStacItem {
  /** STAC item id (typically `<collection>-<date>-<tileid>`). */
  readonly id: string;
  /**
   * The format-specific source. For 3dep-lidar-copc this is always
   * `'copc'`; the field exists so the same shape will work the day we
   * add an EPT-backed STAC collection.
   */
  readonly source: 'copc' | 'ept';
  /** Asset URL (signed for read; works without an API key). */
  readonly assetUrl: string;
  /** WGS84 bbox of the asset's coverage, `[west, south, east, north]`. */
  readonly bbox: BboxWGS84;
  /** EPSG code from STAC `proj:epsg` (when present) — feeds CRS short-circuit. */
  readonly epsg?: number;
  /** ISO datetime range of the capture. */
  readonly datetime?: { readonly start: string; readonly end?: string };
  /** Optional human-readable title (falls back to the id). */
  readonly title?: string;
  /** Optional point count if the STAC item declares one. */
  readonly pointCount?: number;
}

/** Parameters accepted by `searchByBbox`. */
export interface PcSearchByBboxParams {
  readonly bbox: BboxWGS84;
  /** Max items to return (clamped 1..50). Default 12. */
  readonly limit?: number;
  /** Optional STAC item-datetime filter, e.g. `'2020-01-01/..'`. */
  readonly datetime?: string;
  /** Allow the caller to cancel an in-flight request. */
  readonly signal?: AbortSignal;
}

/** Parameters accepted by `searchByLatLon`. */
export interface PcSearchByLatLonParams {
  readonly lat: number;
  readonly lon: number;
  /** Half-side of the search square in degrees. Default 0.05° (~5.5 km). */
  readonly radiusDeg?: number;
  readonly limit?: number;
  readonly datetime?: string;
  readonly signal?: AbortSignal;
}

/** A descriptive error subclass so callers can `instanceof` it. */
export class PlanetaryComputerError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PlanetaryComputerError';
    this.status = status;
  }
}

/**
 * Search the 3DEP LiDAR COPC catalog by WGS84 bbox. Throws on network
 * failure, non-2xx response, or unexpected payload shape — the UI layer
 * catches and surfaces a friendly message (the same path the URL field
 * already uses).
 *
 * The fetch path is the standard `fetch` API; the bbox is encoded into
 * the URL so any HTTP cache (CDN or service worker) can deduplicate.
 */
export async function searchByBbox(
  params: PcSearchByBboxParams,
  fetcher: typeof fetch = fetch,
): Promise<readonly PcStacItem[]> {
  const limit = clampInt(params.limit ?? 12, 1, 50);
  validateBbox(params.bbox);

  const url = new URL(`${PLANETARY_COMPUTER_STAC}/search`);
  url.searchParams.set('collections', PC_COLLECTION_3DEP_COPC);
  url.searchParams.set('bbox', params.bbox.join(','));
  url.searchParams.set('limit', String(limit));
  if (params.datetime) url.searchParams.set('datetime', params.datetime);

  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: params.signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : 'fetch failed';
    throw new PlanetaryComputerError(`STAC request failed: ${message}`);
  }

  if (!response.ok) {
    throw new PlanetaryComputerError(
      `STAC search returned HTTP ${response.status}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new PlanetaryComputerError(
      `STAC search returned invalid JSON: ${(err as Error).message}`,
    );
  }

  return parseFeatureCollection(payload);
}

/**
 * Search by a single lat/lon point plus a small radius. Convenience for
 * the UI's "type a place" affordance — the user enters one location and
 * we surface every PC item within a few km.
 */
export function searchByLatLon(
  params: PcSearchByLatLonParams,
  fetcher: typeof fetch = fetch,
): Promise<readonly PcStacItem[]> {
  const r = Number.isFinite(params.radiusDeg) && (params.radiusDeg ?? 0) > 0
    ? (params.radiusDeg as number)
    : 0.05;
  const bbox: BboxWGS84 = [
    params.lon - r,
    params.lat - r,
    params.lon + r,
    params.lat + r,
  ];
  return searchByBbox(
    {
      bbox,
      limit: params.limit,
      datetime: params.datetime,
      signal: params.signal,
    },
    fetcher,
  );
}

/**
 * Extract a CRS hint a STAC item carries via the `proj:epsg` property
 * so the streaming pipeline can preset the CRS before its own LAS VLR
 * probe completes. Returns null when the item doesn't declare an EPSG.
 */
export function pcStacItemToCrsHint(
  item: PcStacItem,
): { epsg: number; source: 'planetary-computer-stac' } | null {
  if (!item.epsg || !Number.isFinite(item.epsg)) return null;
  return { epsg: item.epsg, source: 'planetary-computer-stac' };
}

/**
 * Exchange a raw PC asset URL for a short-lived SAS-signed URL. Required
 * before any range request — the Azure Blob host returns HTTP 409 when
 * the SAS token is absent. The signing endpoint is public and CORS-
 * enabled; no API key is needed.
 *
 * The signed URL is valid for ~1 hour. A streaming session that lasts
 * longer than that would need to re-sign, but a single COPC open
 * completes in well under that window in practice.
 *
 * Throws `PlanetaryComputerError` on any signing failure so the catalog
 * UI can surface a one-line friendly message.
 */
export async function signAssetUrl(
  rawHref: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (typeof rawHref !== 'string' || rawHref.length === 0) {
    throw new PlanetaryComputerError('signAssetUrl: empty href');
  }
  // The /sign endpoint is idempotent — if the user passes an already-
  // signed URL, the API returns it back unchanged. Cheap to call defensively.
  const url = new URL(`${PLANETARY_COMPUTER_SAS}/sign`);
  url.searchParams.set('href', rawHref);

  let response: Response;
  try {
    response = await fetcher(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    const message = err instanceof Error ? err.message : 'fetch failed';
    throw new PlanetaryComputerError(`SAS sign request failed: ${message}`);
  }

  if (!response.ok) {
    throw new PlanetaryComputerError(
      `SAS sign returned HTTP ${response.status}`,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    throw new PlanetaryComputerError(
      `SAS sign returned invalid JSON: ${(err as Error).message}`,
    );
  }

  if (!isRecord(payload) || typeof payload.href !== 'string') {
    throw new PlanetaryComputerError(
      'SAS sign response missing "href" field',
    );
  }
  return payload.href;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser internals
// ─────────────────────────────────────────────────────────────────────────────

interface RawStacFeatureCollection {
  type?: string;
  features?: readonly RawStacFeature[];
}

interface RawStacFeature {
  type?: string;
  id?: string | number;
  bbox?: readonly number[];
  properties?: Record<string, unknown>;
  assets?: Record<string, { href?: string; type?: string }>;
}

/**
 * Parse and normalise a STAC `FeatureCollection` payload — drop any
 * feature missing the fields the catalog UI + streaming dispatcher
 * actually need. Defensive: bad fields skip the row rather than throw
 * (the user gets fewer results, not a hard failure).
 */
export function parseFeatureCollection(payload: unknown): readonly PcStacItem[] {
  if (!isRecord(payload)) return [];
  const fc = payload as RawStacFeatureCollection;
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return [];
  const items: PcStacItem[] = [];
  for (const f of fc.features) {
    const item = parseFeature(f);
    if (item) items.push(item);
  }
  return items;
}

function parseFeature(f: RawStacFeature): PcStacItem | null {
  if (!f || typeof f !== 'object') return null;
  const id = typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : null;
  if (!id) return null;
  const bbox = asBbox(f.bbox);
  if (!bbox) return null;
  const assets = f.assets ?? {};
  const dataAsset =
    assets.data
    ?? assets.copc
    ?? assets.laz
    // PC sometimes keys the COPC under the file extension as the only
    // asset; pick the first href ending in `.copc.laz` as a fallback.
    ?? Object.values(assets).find(
      (a) => typeof a?.href === 'string' && /\.copc\.la[sz]$/i.test(a.href),
    );
  if (!dataAsset?.href) return null;

  const props = f.properties ?? {};
  const epsg = parseEpsg(props['proj:epsg']);
  const title = typeof props.title === 'string' ? props.title : undefined;
  const pointCount = parsePointCount(props['pc:count']);
  const datetime = parseDatetime(props);

  return {
    id,
    source: 'copc',
    assetUrl: dataAsset.href,
    bbox,
    epsg: epsg ?? undefined,
    title,
    pointCount: pointCount ?? undefined,
    datetime,
  };
}

function asBbox(v: unknown): BboxWGS84 | null {
  if (!Array.isArray(v) || v.length < 4) return null;
  // STAC bbox may be 4-tuple (2D) or 6-tuple (3D with elevation min/max).
  // We only need the 2D extent.
  const w = Number(v[0]);
  const s = Number(v[1]);
  const e = Number(v[v.length === 6 ? 3 : 2]);
  const n = Number(v[v.length === 6 ? 4 : 3]);
  if (![w, s, e, n].every(Number.isFinite)) return null;
  if (w >= e || s >= n) return null;
  if (w < -180 || e > 180 || s < -90 || n > 90) return null;
  return [w, s, e, n];
}

function parseEpsg(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function parsePointCount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return null;
}

function parseDatetime(props: Record<string, unknown>): PcStacItem['datetime'] {
  const single = typeof props.datetime === 'string' ? props.datetime : null;
  const start = typeof props.start_datetime === 'string' ? props.start_datetime : null;
  const end = typeof props.end_datetime === 'string' ? props.end_datetime : null;
  if (start) return { start, end: end ?? undefined };
  if (single) return { start: single };
  return undefined;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function validateBbox(bbox: BboxWGS84): void {
  const [w, s, e, n] = bbox;
  if (!Number.isFinite(w) || !Number.isFinite(s) || !Number.isFinite(e) || !Number.isFinite(n)) {
    throw new PlanetaryComputerError('bbox must have four finite numbers');
  }
  if (w >= e || s >= n) {
    throw new PlanetaryComputerError('bbox must satisfy west < east and south < north');
  }
  if (w < -180 || e > 180 || s < -90 || n > 90) {
    throw new PlanetaryComputerError('bbox must lie within WGS84 bounds');
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
