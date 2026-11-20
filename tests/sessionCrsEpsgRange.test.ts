/**
 * A session file is untrusted input. Its CRS record keeps an EPSG code only
 * when it is a whole number in the EPSG range the WKT reader accepts (1024 to
 * 99999). Any other value is dropped, so the restore gate, which needs a code
 * for a projected or geographic override, applies no CRS from that record.
 */
import { describe, expect, it } from 'vitest';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const USER_UTM: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'user-override',
  confidence: 'high',
  userConfirmed: true,
};

describe('session CRS EPSG range', () => {
  it.each([163684, 3.5, -1, 0, 1023, 100000])('drops epsg %s', (epsg) => {
    const back = parseResolvedCrs({ ...USER_UTM, epsg });
    expect(back).not.toBeNull();
    expect(back?.epsg).toBeUndefined();
    expect(back && 'epsg' in back).toBe(false);
  });

  it.each([1024, 32612, 99999])('keeps epsg %s', (epsg) => {
    expect(parseResolvedCrs({ ...USER_UTM, epsg })?.epsg).toBe(epsg);
  });
});
