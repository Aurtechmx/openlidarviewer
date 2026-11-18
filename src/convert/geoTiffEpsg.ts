/**
 * True when `code` may be written as an EPSG code in a GeoTIFF / LAS GeoKey:
 * an integer in 1024..32766. 32767 is user-defined and 32768..65535 are
 * private (OGC 19-008r4), so those never name an EPSG definition.
 */
export function isGeoTiffEpsgCode(code: number | null | undefined): code is number {
  return code != null && Number.isInteger(code) && code >= 1024 && code <= 32766;
}
