/**
 * crsWktNulTrim.test.ts
 *
 * crsFromWkt strips trailing NUL terminators before parsing. The text can come
 * from a remote ept.json (srs.wkt), so a long run of NULs must be handled in
 * linear time, including a run followed by another character, where an
 * anchored regex retries from every NUL.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';

const WKT =
  'PROJCS["NAD83 / UTM zone 18N",GEOGCS["NAD83",DATUM["North_American_Datum_1983",' +
  'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],' +
  'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'UNIT["metre",1],AUTHORITY["EPSG","26918"]]';

const NUL_RUN = Number(process.env.CRS_NUL_RUN ?? 1 << 20);
// The anchored regex took about 2.6 s at 64K NULs and grows with the square
// of the run, so it would take minutes here. The linear trim takes a few ms,
// or a few hundred under coverage instrumentation.
const LIMIT_MS = 5000;

describe('crsFromWkt trailing NULs', () => {
  it('trims a NUL-terminated WKT to the same result as the plain text', () => {
    const plain = crsFromWkt(WKT);
    expect(plain.epsg).toBe(26918);
    expect(crsFromWkt(`${WKT}\0`)).toEqual(plain);
    expect(crsFromWkt(`  ${WKT} \0\0\0`)).toEqual(plain);
  });

  it(`trims ${NUL_RUN} trailing NULs quickly`, () => {
    const plain = crsFromWkt(WKT);
    const padded = WKT + '\0'.repeat(NUL_RUN);
    const t0 = performance.now();
    const out = crsFromWkt(padded);
    const ms = performance.now() - t0;
    expect(out).toEqual(plain);
    expect(ms).toBeLessThan(LIMIT_MS);
  });

  for (const tail of [' ', 'x']) {
    it(`handles ${NUL_RUN} NULs followed by ${JSON.stringify(tail)} quickly, as a short run`, () => {
      const { wkt: shortText, ...short } = crsFromWkt(WKT + '\0'.repeat(8) + tail);
      const t0 = performance.now();
      const { wkt: text, ...out } = crsFromWkt(WKT + '\0'.repeat(NUL_RUN) + tail);
      const ms = performance.now() - t0;
      expect(out).toEqual(short);
      // The run is not at the end, so it is kept, as it always was.
      expect(text).toBe(shortText?.replace('\0'.repeat(8), '\0'.repeat(NUL_RUN)));
      expect(ms).toBeLessThan(LIMIT_MS);
    });
  }

  it('a string of only NULs parses like an empty one', () => {
    expect(crsFromWkt('\0'.repeat(NUL_RUN))).toEqual(crsFromWkt(''));
  });
});
