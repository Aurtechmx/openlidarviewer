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
