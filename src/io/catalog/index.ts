/**
 * src/io/catalog/index.ts
 *
 * Public surface of the catalog module. Importers stick to this barrel
 * so we can shuffle the internals (providers, helpers) without breaking
 * `main.ts` or the UI layer.
 */

export type {
  CatalogError,
  CatalogProvider,
  CatalogQueryOutcome,
  CatalogQueryResult,
  CatalogTile,
  GeocodeOutcome,
  GeocodeResult,
  LatLon,
  LatLonBbox,
} from './types';

export {
  SourceRegistry,
  flattenAggregated,
  type AggregatedQueryOutcome,
} from './SourceRegistry';

export {
  Usgs3depProvider,
  createUsgs3depProvider,
  type Usgs3depProviderOptions,
} from './Usgs3depProvider';

export {
  geocodeAddress,
  bboxAroundPoint,
  type GeocodeOptions,
} from './geocode';
