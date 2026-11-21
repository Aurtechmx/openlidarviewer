/**
 * trueNorth.ts: the angle between grid north and true north at a point of a
 * projected CRS, for the true-north arrow on the map sheets.
 *
 * Worked from the projection itself: the point is taken to longitude and
 * latitude on the projection's own datum, moved a short way north, and
 * projected back. The direction of that step on the grid is true north. No
 * datum shift is involved, since the angle is a property of the projection.
 */
import proj4 from 'proj4';
import { epsgToProj4 } from '../../convert/epsg';

/**
 * True north at (`x`, `y`) of the CRS `epsg`, in degrees from grid north,
 * clockwise positive (east of grid north). Null when the CRS is unknown, not
 * one proj4 is given a definition for here, geographic (no grid), or the
 * point does not convert.
 */
export function trueNorthFromGridDeg(epsg: number | null | undefined, x: number, y: number): number | null {
  if (epsg == null || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const def = epsgToProj4(epsg);
  if (!def || /\+proj=(longlat|latlong|lonlat|latlon)\b/.test(def)) return null;
  try {
    const conv = proj4(def);
    const [lon, lat] = conv.inverse([x, y]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 89.9) return null;
    const step = 1e-4; // degrees of latitude, about 11 m
    const [x2, y2] = conv.forward([lon, lat + step]);
    const dx = x2 - x, dy = y2 - y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) === 0) return null;
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  } catch {
    return null;
  }
}
