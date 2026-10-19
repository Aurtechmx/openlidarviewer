/**
 * las14PreflightParity.test.ts
 *
 * The converter refuses a LAS 1.4 export before any bytes are produced, using
 * the writer's own CRS plan. That plan reads the horizontal unit: heights in a
 * declared unit with no vertical datum are written when they are in the unit a
 * WKT reader assumes for Z, which is the horizontal one. The preflight used to
 * leave the horizontal unit out, so a WKT-only foot grid with feet heights was
 * refused by the preflight although the writer accepts it.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import { UNIT_FACTORS } from '../src/units/units';

/** A foot grid given only as WKT: no AUTHORITY, so no EPSG code to look up. */
const FOOT_GRID_WKT =
  'PROJCS["Local foot grid",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-105],PARAMETER["scale_factor",0.9996],' +
  'PARAMETER["false_easting",1640416.667],PARAMETER["false_northing",0],UNIT["foot",0.3048],' +
  'AXIS["Easting",EAST],AXIS["Northing",NORTH]]';

function cloud(crs: CrsInfo): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin: [2000000, 14000000, 300],
    sourceFormat: 'las',
    name: 'foot-grid.las',
    metadata: { crs },
  });
}

describe('LAS 1.4 preflight and writer share one CRS plan', () => {
  it('accepts a WKT-only foot grid with feet heights and no vertical datum', () => {
    const declared = crsFromWkt(FOOT_GRID_WKT)!;
    expect(declared.epsg).toBeUndefined();
    const crs: CrsInfo = { ...declared, verticalLinearUnit: 'foot', verticalUnitToMetres: UNIT_FACTORS.M_PER_FT };
    const { file, report } = convertCloud(cloud(crs), { format: 'las14', crsMode: 'keep' });
    expect(report.log.filter((l) => l.level === 'error').map((l) => l.message)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(file).not.toBeNull();
  });

  it('still refuses feet heights under a metre grid, with the reason', () => {
    const metreWkt = FOOT_GRID_WKT.replace('UNIT["foot",0.3048]', 'UNIT["metre",1]');
    const declared = crsFromWkt(metreWkt)!;
    const crs: CrsInfo = { ...declared, verticalLinearUnit: 'foot', verticalUnitToMetres: UNIT_FACTORS.M_PER_FT };
    const { file, report } = convertCloud(cloud(crs), { format: 'las14', crsMode: 'keep' });
    expect(report.ok).toBe(false);
    expect(file).toBeNull();
    expect(report.log.map((l) => l.message).join('\n')).toContain('with no vertical datum');
  });
});
