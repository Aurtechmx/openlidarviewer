import { describe, expect, it } from 'vitest';
import { crsFromEpsg, crsFromGeoTiff, crsFromWkt, impliedProjectedLinearUnit } from '../src/io/crs';
import { resolveEptCrs } from '../src/render/streaming/eptCrs';

const FT_US = 1200 / 3937;

/** Build a GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
function geoKeys(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

describe('a projected EPSG code with no unit key', () => {
  it('does not treat EPSG:2264 (NC ftUS) as metres', () => {
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, 2264]]), null, null);
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnit).not.toBe('metre');
  });

  it('still resolves a known metre family to metres', () => {
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, 32633]]), null, null);
    expect(crs.linearUnit).toBe('metre');
    expect(impliedProjectedLinearUnit(26917)).toBe('metre');
    expect(impliedProjectedLinearUnit(25836)).toBe('metre');
    expect(impliedProjectedLinearUnit(2264)).toBe('unknown');
  });

  it('crsFromEpsg (EPT codes) gives unknown for 2264, not metre', () => {
    expect(crsFromEpsg(2264).linearUnit).toBe('unknown');
    expect(crsFromEpsg(32615).linearUnit).toBe('metre');
  });
});

describe('the metre-family whitelist (each range checked against proj.db)', () => {
  it.each([
    32601, 32660, 32701, 32760, 26901, 26923, 26701, 26722, 6330, 6348, 2955, 2962, 3154, 3160,
    25828, 25838, 3034, 3035, 28348, 28358, 7846, 7859, 3006, 3018, 31466, 31469, 31254, 31259,
    31284, 31287, 3857, 27700, 28992, 2154, 2193,
  ])('EPSG:%i reads as metre', (code) => {
    expect(impliedProjectedLinearUnit(code)).toBe('metre');
  });

  // Foot-unit codes next to a range boundary: 32664 WGS 84 / BLM 14N (ftUS),
  // 2155 and 2194 American Samoa Lambert (ftUS), 2964 NAD27 / Alaska Albers
  // (ftUS), 26729 NAD27 / Alabama East (ftUS), 2263 New York Long Island (ftUS).
  it.each([32664, 2155, 2194, 2964, 26729, 2263])('foot-unit EPSG:%i stays unknown', (code) => {
    expect(impliedProjectedLinearUnit(code)).toBe('unknown');
  });
});

describe('a vertical EPSG code with no vertical unit key', () => {
  it('takes US survey feet from 4096 = 6360', () => {
    const crs = crsFromGeoTiff(geoKeys([[1024, 1], [3072, 26917], [3076, 9001], [4096, 6360]]), null, null);
    expect(crs.verticalEpsg).toBe(6360);
    expect(crs.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs.verticalUnitToMetres).toBeCloseTo(FT_US, 12);
    expect(crs.verticalUnitConflict).toBeUndefined();
  });

  it('WKT: a VERT_CS with no UNIT takes the unit from its code', () => {
    const crs = crsFromWkt(
      'COMPD_CS["x",PROJCS["NAD83 / UTM zone 17N",UNIT["metre",1],AUTHORITY["EPSG","26917"]],' +
        'VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],AUTHORITY["EPSG","6360"]]]',
    );
    expect(crs.linearUnit).toBe('metre');
    expect(crs.verticalEpsg).toBe(6360);
    expect(crs.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs.verticalUnitToMetres).toBeCloseTo(FT_US, 12);
  });

  it('WKT: a VERT_CS UNIT that contradicts its code is reported, not picked', () => {
    const crs = crsFromWkt(
      'VERT_CS["NAVD88 height",VERT_DATUM["NAVD88",2005],UNIT["US survey foot",0.304800609601219],AUTHORITY["EPSG","5703"]]',
    );
    expect(crs.verticalLinearUnit).toBe('unknown');
    expect(crs.verticalUnitConflict).toBeDefined();
  });

  it('EPT codes: horizontal 2264 + vertical 6360', () => {
    const crs = resolveEptCrs({ srs: undefined, srsCodes: { horizontalEpsg: 2264, verticalEpsg: 6360 } });
    expect(crs?.linearUnit).toBe('unknown');
    expect(crs?.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs?.verticalUnitToMetres).toBeCloseTo(FT_US, 12);
  });

  it('EPT: horizontal-only WKT + vertical code 6360 carries the code\'s unit', () => {
    const crs = resolveEptCrs({
      srs: 'PROJCS["NAD83 / UTM zone 17N",UNIT["metre",1],AUTHORITY["EPSG","26917"]]',
      srsCodes: { horizontalEpsg: 26917, verticalEpsg: 6360 },
    });
    expect(crs?.verticalEpsg).toBe(6360);
    expect(crs?.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs?.verticalUnitToMetres).toBeCloseTo(FT_US, 12);
  });
});
