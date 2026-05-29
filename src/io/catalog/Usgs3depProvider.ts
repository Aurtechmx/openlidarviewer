/**
 * src/io/catalog/Usgs3depProvider.ts
 *
 * **EXPERIMENTAL — not wired into the v0.3.6 user flow.**
 *
 * This module is retained as scaffolding for a possible future
 * address-based catalog workflow. The shipped v0.3.6 empty-state UI
 * uses the curated picker in `src/io/catalog/curatedLocations.ts`
 * instead, which ships pre-verified URLs and bypasses bbox-based
 * catalog dispatch entirely. Nothing in the active runtime imports
 * `createUsgs3depProvider`; tree-shaking drops the implementation
 * from the shell bundle.
 *
 * Why the address workflow is currently disabled in v0.3.6
 * ────────────────────────────────────────────────────────
 * Live verification against the TNM Products API (May 2026) showed
 * zero COPC URLs surfaced for every metro bbox we tested — including
 * the four metros TNM's own error message recommends. The published
 * inventory is still entirely legacy `.laz` for browsable bboxes; the
 * 3DEP COPC migration hasn't reached the public TNM index. The
 * provider implementation below would still issue valid requests, but
 * the responses contain no streamable tiles for current bboxes.
 *
 * Original docblock for reference
 * ───────────────────────────────
 * `CatalogProvider` implementation for the U.S. Geological Survey's
 * 3D Elevation Program (3DEP) Lidar Point Cloud (LPC) collection.
 *
 * USGS 3DEP is the only public LiDAR catalog that combines (a) genuine
 * national-scale coverage, (b) a public bbox-queryable HTTP API
 * (TNM Access Products), and (c) staged COPC objects on a CORS-safe
 * S3 bucket. The trio would, in principle, support an address-based
 * workflow without an API key or proxy. The provider is preserved so a
 * future TNM index update (or a sibling provider with reliable COPC
 * coverage) can land via the `SourceRegistry` pattern without rewiring
 * the UI.
 *
 * What this file deliberately does NOT do
 * ──────────────────────────────────────
 * - Talk to the LiDAR Explorer Web Map (a Leaflet UI, not a data API).
 * - Open or parse the COPC bytes — that's the streaming engine's job.
 *   The provider's contract ends at `streamUrl`.
 * - Cache responses across sessions. Caching belongs above the
 *   provider, where the UI can show stale-while-revalidating
 *   indicators. v0.3.6 keeps the provider stateless.
 * - Apply any QL1/QL2 quality thresholds. Those are airborne-survey
 *   acceptance thresholds owned by the report engine, not catalog
 *   filters.
 */

import type {
  CatalogError,
  CatalogProvider,
  CatalogQueryOutcome,
  CatalogTile,
  LatLonBbox,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The National Map's Products endpoint. Returns a JSON list of
 * LPC items intersecting the supplied bbox. CORS-allowed for browser
 * use (`Access-Control-Allow-Origin: *`) at time of v0.3.6 development.
 */
const TNM_PRODUCTS_API = 'https://tnmaccess.nationalmap.gov/api/v1/products';

/** TNM `datasets` value for LiDAR Point Cloud. */
const TNM_DATASET_LPC = 'Lidar Point Cloud (LPC)';

/**
 * Coarse coverage hint. These are deliberately generous AABBs that
 * include U.S. territorial coverage. They keep the provider visible
 * in the source-picker for any U.S. address while avoiding a wasted
 * HTTP round-trip for, say, a query in central France.
 *
 * Note: this is a pre-filter, NOT a coverage guarantee. Sparse areas
 * inside these AABBs still return `no-coverage` from `query()`.
 */
const COVERAGE_REGIONS: readonly LatLonBbox[] = [
  [-125.0, 24.5, -66.9, 49.4], // Contiguous United States
  [-180.0, 51.2, -129.0, 71.5], // Alaska
  [-161.0, 18.9, -154.7, 22.3], // Hawaiian Islands
  [-67.3, 17.9, -65.2, 18.6], // Puerto Rico
  [-65.1, 17.6, -64.5, 18.5], // U.S. Virgin Islands
];

/**
 * Per-attempt timeout for the TNM Products API. The API usually answers
 * in under a second, but under peak load it has been observed to take
 * 15-20 s before returning. An 8 s budget was the early default; users
 * on slow links or during peak periods (afternoon weekdays in the US)
 * routinely hit the timeout and saw "no tiles available — timeout"
 * even when coverage existed. 25 s matches the EPT transport's
 * per-attempt budget so the discipline is consistent across third-
 * party HTTP endpoints.
 */
const DEFAULT_TIMEOUT_MS = 25000;

/**
 * Number of times the provider will retry a transient failure (timeout
 * or 5xx). Matches the EPT transport's three-attempt budget. Permanent
 * 4xx and 'cors' fail fast without burning retries.
 */
const MAX_ATTEMPTS = 2;

/** Hard cap on the number of tiles surfaced to the UI per query. */
const MAX_TILES_PER_QUERY = 25;

// ─────────────────────────────────────────────────────────────────────────────
// TNM API response shape (only the fields we read)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TNM bounding boxes arrive as numbers OR quoted strings depending on
 * the staged-products path the item came from. Same for `sizeInBytes`.
 * We accept both and coerce in the parser.
 */
interface TnmBoundingBox {
  readonly minX?: number | string;
  readonly minY?: number | string;
  readonly maxX?: number | string;
  readonly maxY?: number | string;
}

interface TnmItem {
  readonly title?: string;
  readonly downloadURL?: string;
  readonly downloadLazURL?: string;
  readonly boundingBox?: TnmBoundingBox;
  readonly sizeInBytes?: number | string;
  readonly publicationDate?: string;
  readonly dateCreated?: string;
  readonly format?: string;
}

interface TnmProductsResponse {
  readonly items?: readonly TnmItem[];
  readonly total?: number;
  readonly errors?: readonly unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when two bboxes overlap, INCLUDING edge-touching. The TNM
 * Products API hands back tiles whose maxX/maxY exactly equal a query
 * bbox edge when the query sits on a tile seam — rejecting those drops
 * legitimate coverage. Strict `<`/`>` keeps the test honest while
 * tolerating seams.
 */
function bboxIntersects(a: LatLonBbox, b: LatLonBbox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/**
 * Coerce a TNM response field into a finite number. TNM has historically
 * encoded `boundingBox.minX/minY/maxX/maxY` (and `sizeInBytes`) as either
 * native JSON numbers or quoted strings depending on the staged-products
 * path. A strict `typeof === 'number'` check silently dropped any
 * string-encoded bbox, so the user saw "no coverage" for real coverage.
 */
function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Pull a COPC-suitable streaming URL out of a TNM item. The TNM
 * Products API surfaces COPC under different keys depending on the
 * project — `downloadLazURL` is the most common, `downloadURL`
 * occasionally — so we accept either and verify the extension.
 */
function copcUrlFor(item: TnmItem): string | undefined {
  const candidates = [item.downloadLazURL, item.downloadURL];
  for (const url of candidates) {
    if (typeof url !== 'string' || url.length === 0) continue;
    const lower = url.toLowerCase();
    // Accept either explicit COPC suffix or LAZ in staged-products
    // path. USGS migrated most LPC deliverables to .copc.laz in
    // 2023-2024; older deliverables remain as plain LAZ which the
    // streaming pipeline cannot open. We surface only COPC.
    if (lower.endsWith('.copc.laz') || lower.endsWith('.copc.las')) {
      return url;
    }
  }
  return undefined;
}

function safeYearFromTnmDate(value: string | undefined): number | undefined {
  if (typeof value !== 'string' || value.length < 4) return undefined;
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isFinite(year) && year > 1990 && year < 2100 ? year : undefined;
}

function bboxFromTnm(item: TnmItem): LatLonBbox | undefined {
  const bb = item.boundingBox;
  if (!bb) return undefined;
  const minX = asFiniteNumber(bb.minX);
  const minY = asFiniteNumber(bb.minY);
  const maxX = asFiniteNumber(bb.maxX);
  const maxY = asFiniteNumber(bb.maxY);
  if (
    minX === undefined ||
    minY === undefined ||
    maxX === undefined ||
    maxY === undefined
  ) {
    return undefined;
  }
  if (minX >= maxX || minY >= maxY) return undefined;
  return [minX, minY, maxX, maxY];
}

/** Wrap an AbortSignal with a timeout so the provider honours its budget. */
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

function errorFromUnknown(err: unknown): CatalogError {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name: unknown }).name);
    if (name === 'AbortError') {
      return { code: 'timeout', message: 'USGS 3DEP catalog query timed out.' };
    }
  }
  if (err instanceof TypeError) {
    // `fetch` reports CORS / network failures as `TypeError` in browsers.
    return {
      code: 'cors',
      message:
        'USGS 3DEP catalog query was blocked by the browser. This is usually a ' +
        'transient network or CORS issue — try again in a moment.',
    };
  }
  const message =
    err instanceof Error ? err.message : 'Unknown USGS 3DEP catalog failure.';
  return { code: 'unknown', message };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface Usgs3depProviderOptions {
  /** Override the TNM endpoint (useful in tests). */
  readonly endpoint?: string;
  /** Override the `fetch` implementation (useful in tests). */
  readonly fetchImpl?: typeof fetch;
  /** Override the per-query timeout. */
  readonly timeoutMs?: number;
}

/**
 * The provider object. Pure data + an injectable `fetch` — no module
 * state, no caches. Tests construct one with a fake `fetch` and a
 * synthetic TNM response.
 */
export class Usgs3depProvider implements CatalogProvider {
  readonly id = 'usgs-3dep';
  readonly label = 'USGS 3DEP (United States)';
  readonly description =
    'U.S. Geological Survey 3D Elevation Program — public-domain ' +
    'airborne LiDAR for the United States, served as Cloud Optimized ' +
    'Point Clouds (COPC) on a CORS-safe S3 bucket.';
  readonly attribution = 'U.S. Geological Survey 3DEP';
  readonly license = 'Public domain (USGS).';

  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: Usgs3depProviderOptions = {}) {
    this.endpoint = options.endpoint ?? TNM_PRODUCTS_API;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  coarseCoverage(bbox: LatLonBbox): boolean {
    return COVERAGE_REGIONS.some((region) => bboxIntersects(region, bbox));
  }

  async query(
    bbox: LatLonBbox,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CatalogQueryOutcome> {
    if (!this.coarseCoverage(bbox)) {
      return {
        ok: false,
        error: {
          code: 'no-coverage',
          message:
            'USGS 3DEP only covers the United States and its territories. ' +
            'Try an address inside the U.S., or use a different source.',
        },
      };
    }

    const url = new URL(this.endpoint);
    url.searchParams.set('datasets', TNM_DATASET_LPC);
    url.searchParams.set(
      'bbox',
      `${bbox[0].toFixed(6)},${bbox[1].toFixed(6)},${bbox[2].toFixed(6)},${bbox[3].toFixed(6)}`,
    );
    url.searchParams.set('outputFormat', 'JSON');
    // Server-side format filter — TNM otherwise returns every LPC
    // deliverable (including the legacy non-streamable LAZ tiles we'd
    // discard client-side). Restricting to LAZ trims the payload by
    // ~30-60% and reduces the server-side work the slow path hits.
    url.searchParams.set('prodFormats', 'LAZ');
    // TNM API caps `max` at 1000; we request a modest page since we
    // surface at most MAX_TILES_PER_QUERY rows to the UI anyway.
    url.searchParams.set('max', '50');

    // Attempt loop with retry on transient timeout / 5xx. TNM under load
    // has been observed to take 15-20 s before answering; a single
    // automatic retry on timeout absorbs that without the user having
    // to re-click Search.
    let response: Response | undefined;
    let lastError: CatalogError | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { signal, cancel } = withTimeout(options?.signal, this.timeoutMs);
      try {
        response = await this.fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal,
        });
        cancel();
      } catch (err) {
        cancel();
        const mapped = errorFromUnknown(err);
        lastError = mapped;
        // Only OUR-OWN-internal-timeout retries — CORS, rate-limited,
        // and outer-signal aborts propagate immediately. A second retry
        // on CORS would just block the user for another 25 s on
        // something that's never going to succeed; a second retry on
        // an outer abort would mask the user's explicit cancel.
        const outerAborted = options?.signal?.aborted === true;
        if (
          mapped.code === 'timeout' &&
          !outerAborted &&
          attempt < MAX_ATTEMPTS
        ) {
          continue;
        }
        return { ok: false, error: mapped };
      }
      // 5xx is transient — retry once. 4xx is permanent.
      if (response.status >= 500 && attempt < MAX_ATTEMPTS) {
        lastError = {
          code: 'unknown',
          message: `USGS 3DEP catalog returned HTTP ${response.status}.`,
        };
        continue;
      }
      break;
    }
    if (!response) {
      return {
        ok: false,
        error: lastError ?? {
          code: 'unknown',
          message: 'USGS 3DEP catalog query failed.',
        },
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        error: {
          code: 'rate-limited',
          message:
            'USGS 3DEP catalog is rate-limiting requests. Please try again in a moment.',
        },
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: `USGS 3DEP catalog returned HTTP ${response.status}.`,
        },
      };
    }

    let body: TnmProductsResponse;
    try {
      body = (await response.json()) as TnmProductsResponse;
    } catch {
      return {
        ok: false,
        error: {
          code: 'malformed-response',
          message: 'USGS 3DEP catalog returned a body that could not be parsed.',
        },
      };
    }

    const items = Array.isArray(body.items) ? body.items : [];
    const tiles: CatalogTile[] = [];
    let estimatedBytes = 0;
    // Count of items that LOOK like LiDAR (have a downloadable LAZ URL)
    // but are NOT COPC-staged. Used to differentiate the
    // "USGS hasn't staged COPC here yet" message from the
    // "no LiDAR coverage at all" message — both are no-coverage
    // outcomes today, but the user-facing copy should reflect which.
    let legacyLazCount = 0;

    for (const item of items) {
      if (tiles.length >= MAX_TILES_PER_QUERY) break;
      const streamUrl = copcUrlFor(item);
      if (!streamUrl) {
        // Did TNM at least surface a downloadable LAZ? If so, this
        // area HAS 3DEP coverage; it just isn't COPC-staged yet.
        if (
          (typeof item.downloadLazURL === 'string' && item.downloadLazURL.length > 0) ||
          (typeof item.downloadURL === 'string' &&
            item.downloadURL.toLowerCase().endsWith('.laz'))
        ) {
          legacyLazCount += 1;
        }
        continue;
      }
      const tileBbox = bboxFromTnm(item);
      if (!tileBbox) continue;

      // Defensive: ensure the tile actually intersects the user's bbox.
      // TNM occasionally returns a wider neighbourhood; we'd rather
      // surface fewer accurate tiles than confuse the user.
      if (!bboxIntersects(tileBbox, bbox)) continue;

      const acquisitionYear = safeYearFromTnmDate(
        item.publicationDate ?? item.dateCreated,
      );

      tiles.push({
        id: streamUrl,
        displayName: item.title?.trim() || streamUrl.split('/').pop() || 'USGS LPC tile',
        format: 'copc',
        streamUrl,
        bbox: tileBbox,
        attribution: this.attribution,
        license: this.license,
        acquisitionYear,
        project: item.title?.trim(),
      });

      const tileBytes = asFiniteNumber(item.sizeInBytes);
      if (tileBytes !== undefined && tileBytes > 0) {
        estimatedBytes += tileBytes;
      }
    }

    if (tiles.length === 0) {
      // Two distinct failure modes — make sure the user knows which:
      //   - legacyLazCount > 0 means USGS has 3DEP coverage here but
      //     the tiles are still in the legacy plain-LAZ tier. The user
      //     can wait for USGS to stage COPC, or download the LAZ
      //     manually and convert it locally with PDAL.
      //   - legacyLazCount === 0 means TNM had nothing at all for
      //     this bbox; the user is in a coverage gap.
      const message =
        legacyLazCount > 0
          ? `USGS 3DEP has ${legacyLazCount} LiDAR ${
              legacyLazCount === 1 ? 'tile' : 'tiles'
            } covering this area, but ` +
            'none are yet staged as Cloud Optimized Point Cloud (COPC). ' +
            'COPC is required for browser streaming. The COPC migration ' +
            'is ongoing — try a major U.S. city (San Francisco, ' +
            'Philadelphia, Seattle, Austin) which were staged first.'
          : 'USGS 3DEP has no LiDAR coverage for this area yet. ' +
            'Try a different address — most major U.S. cities and ' +
            'about 80% of the lower 48 are covered.';
      return {
        ok: false,
        error: { code: 'no-coverage', message },
      };
    }

    return {
      ok: true,
      result: {
        tiles,
        estimatedBytes: estimatedBytes > 0 ? estimatedBytes : undefined,
      },
    };
  }
}

/** Convenience factory matching the pattern used by other providers. */
export function createUsgs3depProvider(
  options?: Usgs3depProviderOptions,
): Usgs3depProvider {
  return new Usgs3depProvider(options);
}
