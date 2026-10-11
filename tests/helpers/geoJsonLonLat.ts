/**
 * A pass-through WGS 84 placement for serializer tests whose fixtures already
 * sit inside the lon/lat domain. The GeoJSON writer refuses without one
 * (RFC 7946 fixes its coordinates to WGS 84), so tests of the properties pass
 * this and keep their coordinates unchanged.
 */
import type { GeoJsonLonLat } from '../../src/export/measurementExport';
import type { ResolvedCrs } from '../../src/geo/CoordinateTypes';
import { resolveLocalToLonLat } from '../../src/export/lonLatMapper';

export const IDENTITY_LONLAT: GeoJsonLonLat = {
  map: (p) => [p[0], p[1], p[2]],
  withAltitude: true,
  altitudeNote: 'test placement',
  datumCaveat: null,
};

/** WGS 84 / UTM zone 13N, no vertical datum: positions are written 2D. */
export const UTM13: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};

/** The 2D RFC 7946 position the export writes for a UTM 13N world point. */
export function utm13LonLat(world: readonly number[]): number[] {
  const r = resolveLocalToLonLat(UTM13, [500_000, 4_000_000, 0]);
  if (!r.ok) throw new Error(r.reason);
  const [lon, lat] = r.map([world[0] - 500_000, world[1] - 4_000_000, world[2]]);
  return [Math.round(lon * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
}
