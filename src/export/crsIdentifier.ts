/**
 * crsIdentifier.ts — turning a CRS label into something a GIS reader resolves.
 *
 * The CRS parsers build a DISPLAY name — `NAD83 / UTM zone 13N (EPSG:26913)` —
 * which is right for a panel and wrong for a file. GeoJSON's named-CRS member
 * needs an identifier: a reader that cannot resolve the name falls back to
 * RFC 7946's default WGS84 and reads easting 500000 as longitude 500000, which
 * places the geometry nowhere near the site rather than failing loudly.
 *
 * Pure string work, no I/O, so both the measurement and contour exporters can
 * share one implementation instead of keeping divergent copies.
 */

/**
 * The EPSG code a CRS label names, or null when it names none.
 *
 * Accepts the bare authority form (`EPSG:26913`) and the parenthesised display
 * form the parsers emit (`NAD83 / UTM zone 13N (EPSG:26913)`). Anything else —
 * a local grid name, a placeholder — yields null, because inventing a code is
 * the failure this module exists to prevent.
 */
export function epsgFromCrsLabel(label: string | null | undefined): number | null {
  if (!label) return null;
  const text = label.trim();
  // A string that is ENTIRELY digits can only be a code — unlike a number
  // embedded in prose, which is how `CH1903+ / LV95` came to be read as 1903.
  // Callers that hand this a user-typed code field rely on the bare form.
  const bare = /^(\d{3,6})$/.exec(text);
  const m = bare ?? /(?:^|\()\s*EPSG\s*:\s*(\d+)\s*\)?\s*$/i.exec(text);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isInteger(code) && code > 0 ? code : null;
}

/**
 * An OGC URN (`urn:ogc:def:crs:EPSG::26913`) for a CRS label, or null when no
 * code can be recovered. Callers that must emit something may fall back to the
 * raw label; callers writing a machine-read CRS member should omit it instead.
 */
export function crsUrn(label: string | null | undefined): string | null {
  const code = epsgFromCrsLabel(label);
  return code === null ? null : `urn:ogc:def:crs:EPSG::${code}`;
}
