/**
 * curatedBboxTileCentre.test.ts
 *
 * Each curated record with a known native CRS and a known tile extent must
 * carry a lat/lon bbox that contains the projected centre of that tile.
 */

import { describe, it, expect } from 'vitest';
import proj4 from 'proj4';
import { CURATED_LOCATIONS } from '../src/io/catalog/curatedLocations';
import { epsgToProj4 } from '../src/convert/epsg';

/**
 * Definitions for frames the app's proj4 table does not carry, keyed by
 * record id. Slovenia 1996 / D96 / TM is spelled out here for the check only.
 */
const TEST_ONLY_DEFS: Record<string, string> = {
  'flai-si-clss-2023':
    '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9999 +x_0=500000 +y_0=-5000000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs',
};

/** Native extent [minX, minY, maxX, maxY] per record id. */
const TILE_EXTENTS: Record<string, readonly [number, number, number, number]> = {
  // swissSURFACE3D tile 2485_1109: 1 km square, lower-left corner in km.
  'flai-ch-swisssurface3d-2022': [2_485_000, 1_109_000, 2_486_000, 1_110_000],
  // GURS tile GKOT_433_100: 1 km square, lower-left corner in km.
  'flai-si-clss-2023': [433_000, 100_000, 434_000, 101_000],
  // boundsConforming from the EPT manifest.
  'golden-gate-ca': [-13_695_469, 4_498_166, -13_610_476, 4_633_230],
};

describe('curated bbox contains the projected tile centre', () => {
  it('covers every record with a numeric nativeEpsg', () => {
    const numeric = CURATED_LOCATIONS.filter((l) => typeof l.nativeEpsg === 'number').map((l) => l.id);
    expect(numeric.sort()).toEqual(Object.keys(TILE_EXTENTS).sort());
  });

  it.each(Object.entries(TILE_EXTENTS))('%s', (id, [x0, y0, x1, y1]) => {
    const loc = CURATED_LOCATIONS.find((l) => l.id === id);
    expect(loc, `${id} is missing from the catalogue`).toBeDefined();
    const epsg = loc!.nativeEpsg as number;
    const def = epsgToProj4(epsg) ?? TEST_ONLY_DEFS[id];
    expect(def, `no proj4 definition for EPSG:${epsg}`).toBeTruthy();
    const [lon, lat] = proj4(def!, 'EPSG:4326', [(x0 + x1) / 2, (y0 + y1) / 2]);
    const [minLon, minLat, maxLon, maxLat] = loc!.bbox;
    expect(lon).toBeGreaterThanOrEqual(minLon);
    expect(lon).toBeLessThanOrEqual(maxLon);
    expect(lat).toBeGreaterThanOrEqual(minLat);
    expect(lat).toBeLessThanOrEqual(maxLat);
  });
});
