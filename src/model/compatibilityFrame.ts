/**
 * compatibilityFrame.ts — the one adapter from a resolved CRS to the facts the
 * layer-compatibility classifier reads.
 *
 * The static layer list and the streaming cloud both classify against the same
 * rule, so they must hand it the same facts. They used to build them in two
 * places, and the streaming copy dropped the local-frame name. Both now call
 * this. Pass the RESOLVED CRS (detected metadata with any user override
 * applied), never the raw file metadata.
 *
 * A CRS whose kind is `unknown` declares nothing: no name, no code, no local
 * frame. Nor does the generic "Local coordinates" choice. A display label is
 * never treated as a frame identity on its own.
 */
import type { ResolvedCrs } from '../geo/CoordinateTypes';
import type { CompatibilityInput } from './layerCompatibility';
import { crsDefinitionKey } from '../io/crs';

/** Classifier facts without the layer id. */
export type CompatibilityFrame = Omit<CompatibilityInput, 'id' | 'verticalDatum'> & { readonly verticalDatum?: string };

export function compatibilityFrameOf(crs: ResolvedCrs | null | undefined): CompatibilityFrame {
  if (!crs) return {};
  // The generic "Local coordinates" choice names no frame: every scan marked
  // Local carries the same label, so it declares nothing to compare. Only a
  // named local / engineering frame from the source keys on its name.
  const genericLocal = crs.kind === 'local' && crs.localFrameName === undefined;
  const known = crs.kind !== 'unknown' && !genericLocal;
  // Without an EPSG code the definition, not the name, identifies the CRS.
  const definition = known && crs.epsg === undefined && crs.localFrameName === undefined
    ? crsDefinitionKey(crs.wkt)
    : undefined;
  return {
    ...(known && crs.epsg !== undefined ? { epsg: crs.epsg } : {}),
    ...(known ? { crsName: crs.name } : {}),
    ...(known && crs.localFrameName !== undefined ? { localFrameName: crs.localFrameName } : {}),
    ...(definition !== undefined ? { crsDefinition: definition } : {}),
    ...(crs.verticalDatum !== undefined ? { verticalDatum: crs.verticalDatum } : {}),
    ...(crs.verticalEpsg !== undefined ? { verticalEpsg: crs.verticalEpsg } : {}),
  };
}
