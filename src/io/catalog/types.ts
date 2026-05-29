/**
 * src/io/catalog/types.ts
 *
 * Pure type contracts for the public-LiDAR catalog. The catalog module
 * (CatalogProvider, SourceRegistry, Usgs3depProvider, …) consumes these
 * types and stays free of three.js / pdf-lib / DOM concerns so the unit
 * tests can run in Node.
 *
 * The first release ships a single provider — USGS 3DEP — to validate
 * the seam against a real public S3 bucket without a key. Additional
 * providers slot in as one `CatalogProvider` each, registered against
 * the `SourceRegistry`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Geographic primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Latitude / longitude in WGS-84 decimal degrees. */
export interface LatLon {
  readonly lat: number;
  readonly lon: number;
}

/**
 * A geographic bounding box: `[west, south, east, north]` in WGS-84
 * decimal degrees. The tuple form matches GeoJSON BBOX convention and
 * keeps the surface allocation-cheap.
 */
export type LatLonBbox = readonly [number, number, number, number];

// ─────────────────────────────────────────────────────────────────────────────
// Provider contract — every public-data source implements this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One streamable tile the user can open. The viewer reads only `streamUrl`
 * + `format` to hand off to the existing COPC/EPT streaming pipeline. The
 * other fields populate the dataset summary the panel shows before the
 * user commits.
 */
export interface CatalogTile {
  /** Stable identifier within the source. */
  readonly id: string;
  /** Human-readable name displayed in the panel ("USGS_LPC_CA_…"). */
  readonly displayName: string;
  /** Streaming format. v0.3.6 only ships `copc`. */
  readonly format: 'copc' | 'ept';
  /** URL the streaming pipeline opens. CORS-safe for v0.3.6 (USGS S3). */
  readonly streamUrl: string;
  /** Tile bounds in WGS-84 (for the panel + future overlap detection). */
  readonly bbox: LatLonBbox;
  /** Approximate point count, when the catalog declares one. */
  readonly pointCount?: number;
  /** Approximate point density (pts/m²) when computable. */
  readonly densityPerSqM?: number;
  /** Source attribution string ("U.S. Geological Survey 3DEP"). */
  readonly attribution: string;
  /** License or terms ("Public domain"). */
  readonly license: string;
  /** Acquisition or publication date for the deliverable, when available. */
  readonly acquisitionYear?: number;
  /** Optional human-readable site / project / state name. */
  readonly project?: string;
}

/**
 * Catalog query result. A single `CatalogTile` is the common case (one tile
 * covers the requested AOI); multiple tiles surface as a chooser in the
 * panel.
 */
export interface CatalogQueryResult {
  readonly tiles: readonly CatalogTile[];
  /** Total bytes of the proposed download surface (when known). */
  readonly estimatedBytes?: number;
}

/**
 * The error shape every provider returns instead of throwing for
 * known-bad inputs. Throwing is reserved for genuine transport / parse
 * failures the runtime should treat as bugs.
 */
export interface CatalogError {
  readonly code:
    | 'no-coverage'        // the bbox doesn't intersect any tile
    | 'bad-geocode'        // the address didn't resolve to a usable bbox
    | 'timeout'            // the catalog query exceeded its budget
    | 'malformed-response' // the catalog returned a body the provider can't parse
    | 'unavailable-tile'   // the catalog claims coverage but the tile URL 404s
    | 'cors'               // browser blocked the request
    | 'rate-limited'       // the catalog asked us to back off
    | 'unknown';
  /** User-readable message. The UI surfaces this directly. */
  readonly message: string;
}

export type CatalogQueryOutcome =
  | { readonly ok: true; readonly result: CatalogQueryResult }
  | { readonly ok: false; readonly error: CatalogError };

/**
 * The provider interface every public-data source implements. Stays
 * minimal — query by bbox, return tiles. Anything more elaborate
 * (full-text search, time-window filtering, multi-source aggregation)
 * is out of scope for the current release.
 */
export interface CatalogProvider {
  /** Stable internal id ('usgs-3dep'). */
  readonly id: string;
  /** Human-readable label for the source-picker UI ('USGS 3DEP (USA)'). */
  readonly label: string;
  /** Short description shown in the source-picker UI. */
  readonly description: string;
  /** Attribution to render alongside any tile from this source. */
  readonly attribution: string;
  /** License / terms of use to render alongside any tile from this source. */
  readonly license: string;
  /**
   * Coarse coverage hint — *true* means the provider serves the bbox.
   * The catalog query itself may still return `no-coverage` for sparse
   * areas inside the hint; this is just a fast pre-filter so the UI
   * can hide irrelevant providers globally (e.g., showing 3DEP for a
   * point in France is misleading).
   */
  coarseCoverage(bbox: LatLonBbox): boolean;
  /**
   * Look up tiles that intersect the bbox. The provider is responsible
   * for honouring its own timeout budget and returning a typed error
   * rather than throwing for known failure classes.
   */
  query(
    bbox: LatLonBbox,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CatalogQueryOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geocoding
// ─────────────────────────────────────────────────────────────────────────────

/** Geocoded result for an address lookup. */
export interface GeocodeResult {
  readonly displayName: string;
  readonly center: LatLon;
  readonly bbox: LatLonBbox;
}

export interface GeocodeOutcome {
  readonly ok: boolean;
  readonly result?: GeocodeResult;
  readonly error?: CatalogError;
}
