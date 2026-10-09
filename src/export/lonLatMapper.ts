/**
 * lonLatMapper.ts — mapping local render-space points to longitude/latitude
 * for the KML export.
 *
 * Lived inline in `main.ts`, which left the two behaviours that matter here —
 * declining a CRS the converter cannot handle, and REFUSING a point it cannot
 * convert rather than emitting projected coordinates as degrees — covered by
 * tsc and e2e only. Extracted so both are pinned by unit tests; `main.ts`
 * keeps only the wiring.
 */

import proj4 from 'proj4';

import { utmConverter } from '../geo/UtmConverter';
import { epsgToProj4, epsgDatumFamily, datumShiftCaveat, type DatumFamily } from '../convert/epsg';
import type { ResolvedCrs } from '../geo/CoordinateTypes';

const WGS84_LONLAT = '+proj=longlat +datum=WGS84 +no_defs';

/** proj4's datum_type for a definition that carries no datum (`PJD_NODATUM`). */
const PJD_NODATUM = 5;

/**
 * Raised when a point cannot be expressed in longitude/latitude. The KML
 * caller declines the whole export: its coordinates are geographic by
 * specification, so one unplaceable feature makes the file wrong rather than
 * incomplete.
 */
export class LonLatConversionError extends Error {}

/**
 * A mapper from LOCAL render space to `[lon, lat, sourceZ]`.
 *
 * The name states the whole contract: the first two ordinates are CONVERTED,
 * the third is NOT. A horizontal reprojection establishes nothing about the
 * vertical axis, so the height that comes out is the height that went in —
 * possibly feet, possibly a local engineering height, possibly an ellipsoidal
 * height, possibly a sign-flipped depth. It was previously returned in an
 * `[lon, lat, alt]` tuple, and the KML writer put it straight into a geometry
 * tagged `absolute`, which asserts metres above mean sea level about a number
 * nothing in this pipeline ever placed on that reference. Consumers must
 * either prove the vertical reference themselves or decline to publish it.
 *
 * `datumCaveat`, when set, says the output is NOT exact WGS 84: the source is
 * on a datum (NAD83, ETRS89, GDA94, GDA2020, NZGD2000, RGF93) that is treated
 * as WGS 84 without a transformation. Every
 * file that states WGS 84 longitude/latitude must carry it.
 */
export type LocalToLonLatSourceZ = ((
  p: readonly [number, number, number],
) => [number, number, number]) & { readonly datumCaveat?: string | null };

/** The mapper for a CRS, or the sentence that says why there is none. */
export type LonLatMapperResult =
  | { readonly ok: true; readonly map: LocalToLonLatSourceZ; readonly datumCaveat: string | null }
  | { readonly ok: false; readonly reason: string };

/** The refusal for a CRS this mapper has no conversion for at all. */
export const LONLAT_UNSUPPORTED_CRS =
  "This scan's CRS isn't supported for longitude and latitude export yet.";

const DATUM_LABEL: Record<DatumFamily, string> = {
  WGS84: 'WGS 84',
  NAD83: 'NAD83',
  NAD27: 'NAD27',
  ETRS89: 'ETRS89',
  GDA94: 'GDA94',
  GDA2020: 'GDA2020',
  NZGD2000: 'NZGD2000',
  CGCS2000: 'CGCS2000',
  OSGB36: 'OSGB36',
  RGF93: 'RGF93',
};

const NEEDS_TRANSFORM =
  'Longitude and latitude export needs a datum transformation that OLV does not apply yet.';
const REPROJECT_ELSEWHERE = 'Reproject the scan to WGS 84 with PROJ, GDAL or PDAL, then open the result.';
const REPROJECT_NAD27 =
  'Reproject in OLV applies no NAD27 shift. Reproject the scan to WGS 84 with PROJ, GDAL or PDAL '
  + 'using the NADCON or NTv2 grids, then open the result.';

/** The user-facing refusal for a datum the mapper will not treat as WGS 84. */
export function lonLatDatumRefusal(epsg: number | undefined): string {
  if (epsg == null) {
    return "This scan's CRS has no EPSG code, so its datum cannot be confirmed as WGS 84. "
      + `${NEEDS_TRANSFORM} ${REPROJECT_ELSEWHERE}`;
  }
  const family = epsgDatumFamily(epsg);
  if (family === 'NAD27') {
    // OLV's own Reproject has no NAD27 grids either, so the advice names a
    // grid-capable tool instead of sending the user back to a null shift.
    return `This scan is on NAD27. ${NEEDS_TRANSFORM.replace(/\.$/, ', and')} ${REPROJECT_NAD27}`;
  }
  return family
    ? `This scan is on ${DATUM_LABEL[family]}. ${NEEDS_TRANSFORM} ${REPROJECT_ELSEWHERE}`
    : `This scan's CRS (EPSG:${epsg}) is on a datum OLV cannot confirm as WGS 84. ${NEEDS_TRANSFORM} ${REPROJECT_ELSEWHERE}`;
}

/**
 * The note an export carries for an approximate (NAD83) source. Built from
 * {@link datumShiftCaveat}, so the export and the reprojection warning state
 * the same thing.
 */
function nad83Note(epsg: number): string | null {
  const caveat = datumShiftCaveat(epsg, 4326);
  return caveat
    ? `Approximate positions (about 1 to 2 m): the source CRS is on NAD83. ${caveat}.`
    : null;
}

/**
 * Datums whose proj4 definitions here are a null shift to WGS 84
 * (`+towgs84=0,0,0`, or none for the geographic forms), and how far they
 * have moved from WGS 84. Each is fixed to a plate at a reference epoch while
 * WGS 84 follows ITRF, so the difference grows every year. Sizes are PROJ
 * time-dependent pipelines to ITRF2014 at epoch 2026.75: ETRS89 0.93 m at
 * (10 E, 50 N), GDA2020 0.40 m and GDA94 1.96 m at (145 E, 37 S). RGF93 v2b
 * is aligned to ETRS89. NZGD2000 needs the New Zealand deformation model,
 * which PROJ does not have offline; New Zealand moves several centimetres a
 * year, about 1 m since 2000.
 */
const NULL_SHIFT_SIZE: Partial<Record<DatumFamily, string>> = {
  ETRS89: 'about 1 m',
  RGF93: 'about 1 m',
  GDA94: 'about 2 m',
  GDA2020: 'about 0.4 m',
  NZGD2000: 'about 1 m',
};

function nullShiftNote(family: DatumFamily): string | null {
  const size = NULL_SHIFT_SIZE[family];
  if (!size) return null;
  const label = DATUM_LABEL[family];
  return `Approximate positions (${size}): the source CRS is on ${label}, which is treated here as `
    + `identical to WGS 84. ${label} is fixed to its tectonic plate, so the difference grows each `
    + `year; no ${label} to WGS 84 transformation was applied.`;
}

/**
 * The datum gate both paths share. WGS 84 is exact. NAD83 and the null-shift
 * families above are allowed with a note, because the EPSG registry itself
 * gives null transformations to WGS 84 for them (NAD83 EPSG:1188 at 4 m and
 * NAD83(2011) EPSG:9774 at 2 m; ETRS89 and NZGD2000 at 1 m; GDA94 and GDA2020
 * at 3 m). Everything else (NAD27, CGCS2000 with only a ballpark offset, an
 * unknown or missing code) is refused.
 */
function datumNote(epsg: number | undefined): { ok: true; caveat: string | null } | { ok: false; reason: string } {
  const family = epsg != null ? epsgDatumFamily(epsg) : null;
  if (epsg == null || family == null) return { ok: false, reason: lonLatDatumRefusal(epsg) };
  if (family === 'WGS84') return { ok: true, caveat: null };
  if (family === 'NAD83') return { ok: true, caveat: nad83Note(epsg) };
  const note = nullShiftNote(family);
  return note ? { ok: true, caveat: note } : { ok: false, reason: lonLatDatumRefusal(epsg) };
}

/**
 * Check a longitude/latitude pair before it leaves the mapper.
 *
 * Longitude outside [-180, 180] is REFUSED, not wrapped. In a scan the usual
 * cause is a projected coordinate (an easting of 500000, a state plane value)
 * under a geographic label, and wrapping would turn that into a plausible
 * longitude in the wrong place. Data on a 0 to 360 convention is refused too;
 * reprojecting it to WGS 84 in [-180, 180] first is a one-step fix.
 */
function checkedLonLat(lon: number, lat: number, what: string): void {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new LonLatConversionError(`${what} is not a finite longitude/latitude.`);
  }
  if (lat < -90 || lat > 90) {
    throw new LonLatConversionError(`${what} has latitude ${lat}, outside -90 to 90.`);
  }
  if (lon < -180 || lon > 180) {
    throw new LonLatConversionError(
      `${what} has longitude ${lon}, outside -180 to 180. Longitudes are not wrapped.`,
    );
  }
}

function withCaveat(
  fn: (p: readonly [number, number, number]) => [number, number, number],
  caveat: string | null,
): LocalToLonLatSourceZ {
  return Object.assign(fn, { datumCaveat: caveat });
}

/**
 * The LOCAL render-space → [lon, lat, sourceZ] mapper for the resolved CRS,
 * or the reason there is none (unknown/local CRS, a projected CRS the
 * converter does not handle, or a datum that would need a transformation OLV
 * does not apply).
 *
 * The one-shot probe proves the ORIGIN converts, which gates the export
 * button; a point far enough from the origin can still leave the grid, so the
 * per-point path throws {@link LonLatConversionError} instead of falling back
 * to raw easting/northing — writing easting 500000 into a KML `<coordinates>`
 * element claims longitude 500000, a corrupt file rather than a degraded one.
 */
export function resolveLocalToLonLat(
  resolved: ResolvedCrs | null,
  origin: readonly number[],
): LonLatMapperResult {
  if (!resolved) return { ok: false, reason: LONLAT_UNSUPPORTED_CRS };
  const ox = origin[0] ?? 0;
  const oy = origin[1] ?? 0;
  const oz = origin[2] ?? 0;
  if (resolved.kind === 'geographic') {
    // A geographic CRS is passed through with no arithmetic, so the datum is
    // the whole question.
    const gate = datumNote(resolved.epsg);
    if (!gate.ok) return gate;
    try {
      checkedLonLat(ox, oy, 'The scan origin');
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    const map = withCaveat((p) => {
      const lon = p[0] + ox;
      const lat = p[1] + oy;
      checkedLonLat(lon, lat, 'A point');
      return [lon, lat, p[2] + oz];
    }, gate.caveat);
    return { ok: true, map, datumCaveat: gate.caveat };
  }
  if (resolved.kind === 'projected') {
    const family = resolved.epsg != null ? epsgDatumFamily(resolved.epsg) : null;
    // NAD27 is refused on every path: proj4 has no NAD27 grids and applies a
    // null shift (61.7 m off PROJ in UTM zone 12), and the UTM fast path does
    // not decode it.
    if (family === 'NAD27') return { ok: false, reason: lonLatDatumRefusal(resolved.epsg) };
    // The same note as the geographic path. A family with no note (OSGB36,
    // or a grid with no family such as CH1903+ or S-JTSK) carries a real
    // Helmert shift in its proj4 definition and passes uncaveated.
    const gate = datumNote(resolved.epsg);
    const caveat = gate.ok ? gate.caveat : null;
    // Fast path: the vendored UTM converter handles WGS 84 and NAD83 UTM zones
    // without proj4's general machinery. It uses WGS 84 constants for both, so
    // a NAD83 zone carries the caveat.
    const probe = utmConverter.toGeographic({ x: ox, y: oy, z: oz }, resolved);
    if (probe.ok) {
      const map = withCaveat((p) => {
        const r = utmConverter.toGeographic(
          { x: p[0] + ox, y: p[1] + oy, z: p[2] + oz },
          resolved,
        );
        if (!r.ok) throw new LonLatConversionError(r.reason);
        checkedLonLat(r.value.lon, r.value.lat, `EPSG:${resolved.epsg} point`);
        // Source Z, deliberately UNCONVERTED and deliberately not called an
        // altitude. The converter's `elevation` is the same value passed back
        // out, so preferring it only made the passthrough harder to see.
        return [r.value.lon, r.value.lat, p[2] + oz];
      }, caveat);
      return { ok: true, map, datumCaveat: caveat };
    }
    // General path: any projected CRS with a proj4 definition (national grids
    // like S-JTSK/Krovák, Lambert, Albers). It DECLINES — never approximates —
    // when no definition exists, so the export stays gated rather than writing
    // an easting into a KML <coordinates> element as if it were a longitude.
    // The horizontal axes are reprojected; source Z passes through unconverted,
    // the same contract as the UTM path above.
    const def = resolved.epsg != null ? epsgToProj4(resolved.epsg) : null;
    if (!def) return { ok: false, reason: LONLAT_UNSUPPORTED_CRS };
    // A definition with no datum (PJD_NODATUM) makes proj4 return the point
    // with no datum shift at all. That is right only when the EPSG datum IS
    // WGS 84 (Web Mercator's `+nadgrids=@null`); for anything else it is the
    // same silent null shift that put NAD27 61.7 m off.
    const datumType = (new proj4.Proj(def) as unknown as { datum?: { datum_type?: number } }).datum?.datum_type;
    if (datumType === PJD_NODATUM && family !== 'WGS84') {
      return { ok: false, reason: lonLatDatumRefusal(resolved.epsg) };
    }
    const toWgs84 = proj4(def, WGS84_LONLAT);
    let originOk = false;
    try {
      const o = toWgs84.forward([ox, oy]);
      originOk = Number.isFinite(o[0]) && Number.isFinite(o[1]);
    } catch {
      originOk = false;
    }
    if (!originOk) return { ok: false, reason: LONLAT_UNSUPPORTED_CRS };
    const map = withCaveat((p) => {
      let out: number[];
      try {
        out = toWgs84.forward([p[0] + ox, p[1] + oy]);
      } catch (e) {
        throw new LonLatConversionError(
          `EPSG:${resolved.epsg} point could not be reprojected to lon/lat: ${(e as Error).message}`,
        );
      }
      if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) {
        throw new LonLatConversionError(
          `EPSG:${resolved.epsg} reprojected to a non-finite lon/lat`,
        );
      }
      checkedLonLat(out[0], out[1], `EPSG:${resolved.epsg} point`);
      return [out[0], out[1], p[2] + oz];
    }, caveat);
    return { ok: true, map, datumCaveat: caveat };
  }
  return { ok: false, reason: LONLAT_UNSUPPORTED_CRS };
}

/**
 * The mapper alone, or null when {@link resolveLocalToLonLat} refuses. Callers
 * that show the user why use {@link resolveLocalToLonLat} directly.
 */
export function makeLocalToLonLat(
  resolved: ResolvedCrs | null,
  origin: readonly number[],
): LocalToLonLatSourceZ | null {
  const r = resolveLocalToLonLat(resolved, origin);
  return r.ok ? r.map : null;
}

/**
 * The Analyse panel's lon/lat context for a scan: the render-local mapper, a
 * WORLD (origin-restored) wrapper that carries the same datum caveat, or the
 * mapper's refusal. Empty when there is no origin or CRS yet.
 */
export function lonLatMapContext(
  resolved: ResolvedCrs | null,
  origin: readonly number[] | null,
): {
  localToLonLat?: LocalToLonLatSourceZ;
  worldToLonLat?: LocalToLonLatSourceZ;
  lonLatRefusal?: string;
} {
  if (!origin || !resolved) return {};
  const o: [number, number, number] = [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0];
  const r = resolveLocalToLonLat(resolved, o);
  if (!r.ok) return { lonLatRefusal: r.reason };
  const local = r.map;
  const world = withCaveat((p) => local([p[0] - o[0], p[1] - o[1], p[2] - o[2]]), r.datumCaveat);
  return { localToLonLat: local, worldToLonLat: world };
}
