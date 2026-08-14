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
import { epsgToProj4 } from '../convert/epsg';
import type { ResolvedCrs } from '../geo/CoordinateTypes';

const WGS84_LONLAT = '+proj=longlat +datum=WGS84 +no_defs';

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
 */
export type LocalToLonLatSourceZ = (
  p: readonly [number, number, number],
) => [number, number, number];

/**
 * A LOCAL render-space → [lon, lat, alt] mapper for the resolved CRS, or null
 * when no honest mapping exists (unknown/local CRS, or a projected CRS the
 * vendored converter does not handle — those decline rather than approximate).
 *
 * The one-shot probe proves the ORIGIN converts, which gates the export
 * button; a point far enough from the origin can still leave the grid, so the
 * per-point path throws {@link LonLatConversionError} instead of falling back
 * to raw easting/northing — writing easting 500000 into a KML `<coordinates>`
 * element claims longitude 500000, a corrupt file rather than a degraded one.
 */
export function makeLocalToLonLat(
  resolved: ResolvedCrs | null,
  origin: readonly number[],
): LocalToLonLatSourceZ | null {
  if (!resolved) return null;
  const ox = origin[0] ?? 0;
  const oy = origin[1] ?? 0;
  const oz = origin[2] ?? 0;
  if (resolved.kind === 'geographic') {
    return (p) => [p[0] + ox, p[1] + oy, p[2] + oz];
  }
  if (resolved.kind === 'projected') {
    // Fast path: the vendored UTM converter handles USGS/international UTM zones
    // without proj4's general machinery.
    const probe = utmConverter.toGeographic({ x: ox, y: oy, z: oz }, resolved);
    if (probe.ok) {
      return (p) => {
        const r = utmConverter.toGeographic(
          { x: p[0] + ox, y: p[1] + oy, z: p[2] + oz },
          resolved,
        );
        if (!r.ok) throw new LonLatConversionError(r.reason);
        // Source Z, deliberately UNCONVERTED and deliberately not called an
        // altitude. The converter's `elevation` is the same value passed back
        // out, so preferring it only made the passthrough harder to see.
        return [r.value.lon, r.value.lat, p[2] + oz];
      };
    }
    // General path: any projected CRS with a proj4 definition (national grids
    // like S-JTSK/Krovák, Lambert, Albers). It DECLINES — never approximates —
    // when no definition exists, so the export stays gated rather than writing
    // an easting into a KML <coordinates> element as if it were a longitude.
    // The horizontal axes are reprojected; source Z passes through unconverted,
    // the same contract as the UTM path above.
    const def = resolved.epsg != null ? epsgToProj4(resolved.epsg) : null;
    if (!def) return null;
    const toWgs84 = proj4(def, WGS84_LONLAT);
    let originOk = false;
    try {
      const o = toWgs84.forward([ox, oy]);
      originOk = Number.isFinite(o[0]) && Number.isFinite(o[1]);
    } catch {
      originOk = false;
    }
    if (!originOk) return null;
    return (p) => {
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
      return [out[0], out[1], p[2] + oz];
    };
  }
  return null;
}
