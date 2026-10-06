/**
 * crsOrigin.ts — where an export's coordinate system came from, for export
 * provenance.
 *
 * The record is copied from the resolved CRS (`CrsService.current()`); nothing
 * is recomputed. `source` is the resolved CRS's own token (`las-vlr`,
 * `las-evlr`, `user-override`, ...), with a catalogue assertion's label
 * appended (`catalog-tile (swisstopo LV95)`). Every field is `'unknown'` when no CRS was
 * resolved.
 *
 * Pure data and a leaf: no DOM, no I/O and no imports, so only the lazy export
 * paths that write provenance load it.
 */

export interface CrsOriginRecord {
  readonly source: string;
  readonly name: string;
  readonly epsg: string;
  readonly verticalDatum: string;
  readonly verticalSource: string;
}

/** The fields of a resolved CRS the record reads (structural, so this module stays import-free). */
export interface CrsOriginInput {
  readonly source: string;
  readonly name: string;
  readonly epsg?: number;
  readonly verticalEpsg?: number;
  readonly verticalDatum?: string;
  readonly assertedBy?: string;
}

/**
 * The origin of a CRS the file itself declared (the batch converter has no
 * resolver): its `source` token names how the file carried it. Null when the
 * file declared none.
 */
export function declaredCrsOrigin(
  crs: { readonly source: string; readonly name: string; readonly epsg?: number; readonly verticalEpsg?: number; readonly verticalDatum?: string } | null | undefined,
): CrsOriginInput | null {
  if (!crs) return null;
  return {
    source: `file-${crs.source}`,
    name: crs.name,
    ...(crs.epsg !== undefined ? { epsg: crs.epsg } : {}),
    ...(crs.verticalEpsg !== undefined ? { verticalEpsg: crs.verticalEpsg } : {}),
    ...(crs.verticalDatum !== undefined ? { verticalDatum: crs.verticalDatum } : {}),
  };
}

export function crsOriginOf(resolved: CrsOriginInput | null | undefined): CrsOriginRecord {
  const u = 'unknown';
  if (!resolved) return { source: u, name: u, epsg: u, verticalDatum: u, verticalSource: u };
  const vertical = resolved.verticalEpsg != null ? `EPSG:${resolved.verticalEpsg}` : resolved.verticalDatum;
  const source = resolved.assertedBy ? `${resolved.source} (${resolved.assertedBy})` : resolved.source;
  return {
    source,
    name: resolved.name,
    epsg: resolved.epsg != null ? `EPSG:${resolved.epsg}` : u,
    verticalDatum: vertical ?? u,
    verticalSource: vertical ? source : u,
  };
}

/** One README / description line naming the CRS origin. */
export function crsOriginLine(o: CrsOriginRecord): string {
  return `CRS source ${o.source} (${o.name}, ${o.epsg}); vertical datum ${o.verticalDatum} from ${o.verticalSource}`;
}
