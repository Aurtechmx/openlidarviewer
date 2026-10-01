/**
 * catalogueCrs.ts — the coordinate system a catalogue source's product
 * specification states, for tiles that carry no CRS record of their own.
 *
 * swissSURFACE3D tiles are published without a WKT VLR or EVLR (the header
 * sets the WKT bit but no record follows), so the file alone cannot be placed
 * on a map. swisstopo's product page states one frame for the whole product,
 * LV95 / LN02, and this table carries that statement for the curated record
 * it applies to. The tests hold each entry's URL and horizontal EPSG to the
 * record's `streamUrl` and `nativeEpsg`.
 *
 * The assertion is labelled, never silent: it resolves to the `catalog-tile`
 * CRS source with its label, so the Inspector, the state strip and export
 * provenance all name it. A CRS the file carries and a CRS the user sets both
 * take precedence.
 *
 * Kept apart from `curatedLocations.ts`, and importing nothing at runtime, so
 * it loads with the streaming chunk rather than the entry chunk.
 */

import type { CrsInfo } from '../crs';

export interface CatalogueCrsAssertion {
  /** The curated record (`CURATED_LOCATIONS`) this frame belongs to. */
  readonly id: string;
  readonly horizontalEpsg: number;
  readonly verticalEpsg: number;
  readonly verticalDatum: string;
  /** CRS name and horizontal datum as the publisher writes them. */
  readonly name: string;
  readonly horizontalDatum: string;
  /** Names the assertion wherever the CRS source is shown. */
  readonly label: string;
  /** The product page the frame was read from. */
  readonly specUrl: string;
}

/** Curated stream URL → the frame its product specification states. */
export const CATALOGUE_CRS_ASSERTIONS: Readonly<Record<string, CatalogueCrsAssertion>> = {
  'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz': {
    id: 'flai-ch-swisssurface3d-2022',
    horizontalEpsg: 2056,
    verticalEpsg: 5728,
    verticalDatum: 'LN02 height',
    name: 'CH1903+ / LV95',
    horizontalDatum: 'CH1903+',
    label: 'swisstopo LV95',
    specUrl: 'https://www.swisstopo.admin.ch/en/height-model-swisssurface3d',
  },
};

/**
 * The asserted CRS for a curated stream URL, or null when the URL carries no
 * assertion. Projected, metres on both axes.
 */
export function catalogueCrsFor(url: string): CrsInfo | null {
  const a = Object.hasOwn(CATALOGUE_CRS_ASSERTIONS, url) ? CATALOGUE_CRS_ASSERTIONS[url] : undefined;
  if (!a) return null;
  return {
    source: 'epsg',
    name: a.name,
    epsg: a.horizontalEpsg,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    verticalEpsg: a.verticalEpsg,
    verticalDatum: a.verticalDatum,
    verticalLinearUnit: 'metre',
    verticalUnitToMetres: 1,
    horizontalDatum: a.horizontalDatum,
    catalogue: a.label,
  };
}
