import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { compareSpatialFrames } from '../src/geo/frameCompatibility';

/** Two site grids that share a name and nothing else: no EPSG, different false eastings. */
function siteGrid(falseEasting: number): CrsInfo {
  const wkt =
    'PROJCS["Site Grid",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
    'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
    'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-111],PARAMETER["scale_factor",0.9996],' +
    `PARAMETER["false_easting",${falseEasting}],PARAMETER["false_northing",0],UNIT["metre",1]]`;
  return { source: 'wkt', name: 'Site Grid', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false, wkt };
}

describe('two custom coordinate systems with one name', () => {
  it('are different frames when their definitions differ', () => {
    const r = compareSpatialFrames(spatialContextFrom(siteGrid(100000)), spatialContextFrom(siteGrid(250000)));
    expect(r.horizontalFrameConflict).toBe(true);
    expect(r.planimetricComparable).toBe(false);
  });

  it('stay comparable when the definitions agree', () => {
    const r = compareSpatialFrames(spatialContextFrom(siteGrid(100000)), spatialContextFrom(siteGrid(100000)));
    expect(r.horizontalFrameConflict).toBe(false);
  });

  it('names the reason when only the name matches', () => {
    const named: CrsInfo = { source: 'wkt', name: 'Site Grid', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false };
    const r = compareSpatialFrames(spatialContextFrom(named), spatialContextFrom(named));
    expect(r.planimetricComparable).toBe(false);
    expect(r.notes.join(' ')).toMatch(/Both sides name Site Grid/);
    expect(r.notes.join(' ')).not.toMatch(/Horizontal CRS is unknown/);
  });
});
