/**
 * providerInterface.ts
 *
 * Data-only descriptors for Context View basemap tile providers. NO code in
 * src/geo/context fetches anything: actually requesting tiles is the UI
 * adapter's job, it sits behind the consent gate ({@link ../consent}), and it
 * is staged pending device verification. These descriptors only say what a
 * provider IS — id, name, attribution, URL template, zoom ceiling.
 *
 * `requiresConsent` is the literal type `true`: every remote provider requires
 * consent by construction, and the type system refuses a descriptor that
 * claims otherwise. The offline fallback is a SEPARATE type without a
 * `urlTemplate` at all — an offline provider with a fake empty URL would
 * invite an adapter to fetch it; a missing property cannot be fetched.
 */

/** A remote tile provider. Purely descriptive; nothing here performs I/O. */
export interface ContextTileProvider {
  /** Stable identifier (e.g. 'osm'). */
  readonly id: string;
  /** Human-readable provider name. */
  readonly name: string;
  /** Attribution the UI MUST display whenever this provider's tiles are shown. */
  readonly attribution: string;
  /** Slippy-map URL template with {z}/{x}/{y} placeholders. */
  readonly urlTemplate: string;
  /** Maximum tile zoom the provider serves. */
  readonly maxZoom: number;
  /** Literal true: remote tiles ALWAYS require an explicit session consent grant. */
  readonly requiresConsent: true;
}

/**
 * The offline (no-basemap) mode. Deliberately NOT a ContextTileProvider with
 * an empty urlTemplate — it has no urlTemplate property, so there is nothing
 * to fetch and no consent to require.
 */
export interface OfflineProvider {
  readonly id: 'none';
  readonly name: string;
  /** Nothing rendered, nothing to attribute. */
  readonly attribution: '';
  readonly requiresConsent: false;
}

/** The default: render no basemap tiles at all. */
export const NULL_PROVIDER: OfflineProvider = Object.freeze({
  id: 'none',
  name: 'No basemap (offline)',
  attribution: '',
  requiresConsent: false,
});

/**
 * OpenStreetMap's standard tile layer, as a data-only descriptor. Attribution
 * is required by the OSM tile usage policy and must be shown with the tiles.
 */
export const OSM_PROVIDER: ContextTileProvider = Object.freeze({
  id: 'osm',
  name: 'OpenStreetMap',
  attribution: '© OpenStreetMap contributors',
  urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  maxZoom: 19,
  requiresConsent: true,
});
