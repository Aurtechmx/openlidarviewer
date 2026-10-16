/**
 * The vendored UTM converter against proj4's utm (the extended transverse
 * Mercator), in both directions, over everything the converter accepts:
 * eastings 100 000 to 900 000 m at any UTM latitude. The truncated Snyder
 * series used before was 0.195 m off at 23 E, 77.8 N, 3.0 m at 27 E, 79.6 N
 * and 53.6 m at 33 E, 80.1 N (Svalbard in zone 33), and 1.9 km at the
 * zone edge near 84 N.
 */
import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { utmConverter, latLonToUtm } from '../src/geo/UtmConverter';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
const crs = (epsg: number): ResolvedCrs =>
  ({
    kind: 'projected', name: `EPSG:${epsg}`, epsg, linearUnit: 'metre', linearUnitToMetres: 1,
    source: 'las-vlr', confidence: 'high', userConfirmed: false,
  }) as ResolvedCrs;

/** Ground distance in metres between two nearby lon/lat points. */
function groundM(lonA: number, latA: number, lonB: number, latB: number): number {
  const r = 6378137;
  const dLat = ((latA - latB) * Math.PI) / 180;
  const dLon = (((lonA - lonB) * Math.PI) / 180) * Math.cos((latA * Math.PI) / 180);
  return r * Math.hypot(dLat, dLon);
}

describe('UTM inverse matches proj4 utm to under 1 mm', () => {
  for (const [zone, south] of [[33, false], [12, false], [55, true]] as const) {
    it(`zone ${zone}${south ? 'S' : 'N'} over the accepted grid`, () => {
      const def = `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
      const inv = proj4(def, WGS84);
      const epsg = (south ? 32700 : 32600) + zone;
      const northings = south
        ? [1200000, 3000000, 6000000, 9000000, 10000000, 10090000]
        : [-90000, 0, 2000000, 5000000, 7000000, 8500000, 9300000];
      let worst = 0;
      let n = 0;
      for (const northing of northings) {
        for (let easting = 100000; easting <= 900000; easting += 50000) {
          const r = utmConverter.toGeographic({ x: easting, y: northing, z: 0 }, crs(epsg));
          expect(r.ok).toBe(true);
          if (!r.ok) continue;
          const [lon, lat] = inv.forward([easting, northing]);
          worst = Math.max(worst, groundM(r.value.lon, r.value.lat, lon, lat));
          n++;
        }
      }
      expect(n).toBeGreaterThan(90);
      expect(worst).toBeLessThan(0.001);
    });
  }

  for (const [name, lon, lat] of [['Edgeoya', 23.0, 77.8], ['Nordaustlandet east', 27.0, 79.6], ['Kvitoya', 33.0, 80.1]] as const) {
    it(`${name} (${lon} E, ${lat} N) in zone 33N`, () => {
      const [e, n] = proj4(WGS84, '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs').forward([lon, lat]);
      const r = utmConverter.toGeographic({ x: e, y: n, z: 0 }, crs(32633));
      expect(r.ok).toBe(true);
      if (r.ok) expect(groundM(r.value.lon, r.value.lat, lon, lat)).toBeLessThan(0.001);
    });
  }
});

describe('UTM forward matches proj4 utm to under 1 mm', () => {
  it('across latitudes and up to the zone edges, including the widened Svalbard zones', () => {
    let worst = 0;
    for (const lat of [-79.9, -45, -10, 0, 0.5, 30, 56.5, 63.9, 72.5, 79.6, 83.9]) {
      for (let lon = -180; lon < 180; lon += 7.3) {
        const g = latLonToUtm(lat, lon);
        const def = `+proj=utm +zone=${g.zone}${g.hemisphere === 'S' ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
        const [e, n] = proj4(WGS84, def).forward([lon, lat]);
        worst = Math.max(worst, Math.hypot(g.easting - e, g.northing - n));
      }
    }
    expect(worst).toBeLessThan(0.001);
  });
});
