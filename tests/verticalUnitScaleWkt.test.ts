/**
 * verticalUnitScaleWkt.test.ts — the declared vertical unit factor survives
 * parsing, and a declared vertical unit that cannot be read stays invalid.
 *
 * A WKT vertical unit is a name and a metres-per-unit factor. The factor is the
 * physical scale (PROJ and PDAL read it that way): UNIT["centimetre",0.01] is
 * 0.01 m per unit, never a metre because its name contains "metre". The token
 * is metre / foot / US survey foot only when the factor is that unit. A unit
 * that is not a length, or whose factor is missing, zero, negative or not
 * finite, is invalid: it never falls back to the vertical code's unit or the
 * horizontal unit, and it stays invalid through a saved session.
 */

import { describe, it, expect } from 'vitest';
import { crsFromWkt, crsFromGeoTiff, resolveVerticalUnit } from '../src/io/crs';
import { parseLasHeader } from '../src/io/lasHeader';
import { writeLas } from '../src/convert/writeLas';
import { wktForEpsg } from '../src/io/epsgWkt';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import { spatialContextFrom, verticalMetresPerUnit } from '../src/geo/SpatialContext';
import { CrsService } from '../src/geo/CrsService';

const UTM13 = wktForEpsg(32613)!;
const US_FT = 1200 / 3937;

const wkt1Compound = (unit: string, vertAuthority = ''): string =>
  `COMPD_CS["UTM and local height",${UTM13},VERT_CS["Local height",VERT_DATUM["Local datum",2005],${unit},AXIS["Up",UP]${vertAuthority}]]`;
const wkt1Standalone = (unit: string): string => `VERT_CS["Local height",VERT_DATUM["Local datum",2005],${unit},AXIS["Up",UP]]`;
const WKT2_UTM13 =
  'PROJCRS["WGS 84 / UTM zone 13N",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],' +
  'PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]],CONVERSION["UTM zone 13N",METHOD["Transverse Mercator"]],CS[Cartesian,2],' +
  'AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",32613]]';
const wkt2Compound = (unit: string): string =>
  `COMPOUNDCRS["UTM and local height",${WKT2_UTM13},VERTCRS["Local height",VDATUM["Local datum"],CS[vertical,1],AXIS["gravity-related height (H)",up,${unit}]]]`;
const wkt2Standalone = (unit: string): string => `VERTCRS["Local height",VDATUM["Local datum"],CS[vertical,1],AXIS["gravity-related height (H)",up],${unit}]`;

const LENGTHS: ReadonlyArray<readonly [string, number, 'metre' | 'foot' | 'us-survey-foot' | 'unknown']> = [
  ['centimetre', 0.01, 'unknown'],
  ['millimetre', 0.001, 'unknown'],
  ['kilometre', 1000, 'unknown'],
  ['yard', 0.9144, 'unknown'],
  ['metre', 1, 'metre'],
  ['foot', 0.3048, 'foot'],
  ['US survey foot', US_FT, 'us-survey-foot'],
];

const SHAPES = [
  ['WKT1 compound', (n: string, f: number) => wkt1Compound(`UNIT["${n}",${f}]`)],
  ['WKT1 standalone', (n: string, f: number) => wkt1Standalone(`UNIT["${n}",${f}]`)],
  ['WKT2 compound', (n: string, f: number) => wkt2Compound(`LENGTHUNIT["${n}",${f}]`)],
  ['WKT2 standalone', (n: string, f: number) => wkt2Standalone(`LENGTHUNIT["${n}",${f}]`)],
] as const;

describe('a valid vertical length unit keeps its declared factor', () => {
  for (const [shape, build] of SHAPES) {
    it.each(LENGTHS)(`${shape}: %s carries %s m per unit`, (name, factor, token) => {
      const crs = crsFromWkt(build(name, factor));
      expect(crs.verticalUnitToMetres).toBeCloseTo(factor, 15);
      expect(crs.verticalLinearUnit).toBe(token);
      expect(crs.verticalUnitConflict).toBeUndefined();
      const ctx = spatialContextFrom(crs);
      expect(ctx.verticalScaleState).toBe('valid');
      expect(ctx.verticalScaleKnown).toBe(true);
      // 100 source units of height is 100 × factor metres, under every policy.
      for (const policy of ['none', 'horizontal-when-known', 'horizontal'] as const) {
        expect(100 * verticalMetresPerUnit(ctx, policy)!).toBeCloseTo(100 * factor, 9);
      }
    });
  }

  it('the compound horizontal unit is not taken from the vertical clause', () => {
    const crs = crsFromWkt(wkt1Compound('UNIT["centimetre",0.01]'));
    expect(crs.epsg).toBe(32613);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
  });

  it('an unfamiliar unit name with an explicit factor is converted by that factor', () => {
    const crs = crsFromWkt(wkt1Compound('UNIT["Clarke\'s link",0.201166195164]'));
    expect(crs.verticalUnitToMetres).toBe(0.201166195164);
    expect(crs.verticalLinearUnit).toBe('unknown');
    expect(crs.verticalUnitNote).toMatch(/Clarke's link.*0\.201166195164 m per unit/);
    expect(spatialContextFrom(crs).verticalScaleState).toBe('valid');
  });

  it('a familiar name with a conflicting factor: the factor is used and the conflict is noted', () => {
    const asFoot = crsFromWkt(wkt1Compound('UNIT["metre",0.3048]'));
    expect(asFoot.verticalUnitToMetres).toBe(0.3048);
    expect(asFoot.verticalLinearUnit).toBe('foot');
    expect(asFoot.verticalUnitNote).toMatch(/"metre" disagrees with its factor \(0\.3048 m per unit\); the factor is used/);
    const odd = crsFromWkt(wkt2Compound('LENGTHUNIT["foot",0.5]'));
    expect(odd.verticalUnitToMetres).toBe(0.5);
    expect(odd.verticalLinearUnit).toBe('unknown');
    expect(odd.verticalUnitNote).toMatch(/"foot" disagrees/);
  });

  it('a factor written at limited precision is still recognised as its named unit', () => {
    const crs = crsFromWkt(wkt1Compound('UNIT["US survey foot",0.304800609601219]'));
    expect(crs.verticalLinearUnit).toBe('us-survey-foot');
    expect(crs.verticalUnitToMetres).toBe(US_FT);
  });

  it('a declared factor overrides the unit of the vertical code, and says so', () => {
    const crs = crsFromWkt(wkt1Compound('UNIT["centimetre",0.01]', ',AUTHORITY["EPSG","5703"]'));
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalUnitToMetres).toBe(0.01);
    expect(crs.verticalUnitNote).toMatch(/overrides the unit of EPSG:5703/);
  });
});

describe('a declared vertical unit that cannot be read is invalid, not absent', () => {
  const INVALID: ReadonlyArray<readonly [string, string]> = [
    ['missing factor', 'UNIT["metre"]'],
    ['zero factor', 'UNIT["metre",0]'],
    ['negative factor', 'UNIT["metre",-1]'],
    ['non-finite factor', 'UNIT["metre",1e999]'],
    ['angular unit', 'UNIT["degree",0.0174532925199433]'],
    ['WKT2 angular unit', 'ANGLEUNIT["degree",0.0174532925199433]'],
  ];
  for (const withEpsg of [false, true]) {
    it.each(INVALID)(`%s ${withEpsg ? 'with' : 'without'} a vertical EPSG`, (_label, unit) => {
      const crs = crsFromWkt(wkt1Compound(unit, withEpsg ? ',AUTHORITY["EPSG","5703"]' : ''));
      if (withEpsg) expect(crs.verticalEpsg).toBe(5703);
      // Never the code's own metre, never the horizontal metre.
      expect(crs.verticalLinearUnit).toBe('unknown');
      expect(Number.isFinite(crs.verticalUnitToMetres)).toBe(false);
      expect(crs.verticalUnitConflict).toMatch(/not a length unit that can be read/);
      const ctx = spatialContextFrom(crs);
      expect(ctx.verticalScaleState).toBe('invalid');
      for (const policy of ['none', 'horizontal-when-known', 'horizontal'] as const) {
        expect(verticalMetresPerUnit(ctx, policy)).toBeUndefined();
      }
    });
  }

  it('no vertical unit at all is absent: the code unit applies, else none is claimed', () => {
    const none = crsFromWkt(`COMPD_CS["x",${UTM13},VERT_CS["Local height",VERT_DATUM["Local datum",2005],AXIS["Up",UP]]]`);
    expect(none.verticalUnitToMetres).toBeUndefined();
    expect(spatialContextFrom(none).verticalScaleState).toBe('absent');
    // Absent borrows the horizontal metre under the horizontal policies only.
    expect(verticalMetresPerUnit(spatialContextFrom(none), 'none')).toBeUndefined();
    expect(verticalMetresPerUnit(spatialContextFrom(none), 'horizontal-when-known')).toBe(1);
    const coded = crsFromWkt(`COMPD_CS["x",${UTM13},VERT_CS["Local height",VERT_DATUM["Local datum",2005],AXIS["Up",UP],AUTHORITY["EPSG","5703"]]]`);
    expect(coded.verticalUnitToMetres).toBe(1);
    expect(spatialContextFrom(coded).verticalScaleState).toBe('valid');
  });

  it('an angular VerticalUnitsGeoKey (9102) beside NAVD88 is invalid', () => {
    const bytes = writeLas(
      { count: 2, x: new Float64Array([500000, 500000]), y: new Float64Array([4000000, 4000000]), z: new Float64Array([100, 200]) },
      { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9102 },
    );
    const crs = parseLasHeader(bytes.buffer as ArrayBuffer).crs!;
    expect(crs.verticalEpsg).toBe(5703);
    expect(crs.verticalLinearUnit).toBe('unknown');
    expect(spatialContextFrom(crs).verticalScaleState).toBe('invalid');
    expect(verticalMetresPerUnit(spatialContextFrom(crs), 'horizontal')).toBeUndefined();
  });

  it('resolveVerticalUnit takes a declared factor, and an invalid one is never the code unit', () => {
    expect(resolveVerticalUnit({ name: 'yard', toMetres: 0.9144 }, 5703)).toMatchObject({ unit: 'unknown', toMetres: 0.9144 });
    const bad = resolveVerticalUnit({ name: 'metre', toMetres: 0 }, 5703);
    expect(bad.unit).toBe('unknown');
    expect(Number.isNaN(bad.toMetres)).toBe(true);
    // A GeoKey unit code that is no length still reads the same way.
    const keyed = crsFromGeoTiff(new Uint8Array(new Uint16Array([1, 1, 0, 2, 4096, 0, 1, 5703, 4099, 0, 1, 9102]).buffer), null, null);
    expect(Number.isFinite(keyed.verticalUnitToMetres)).toBe(false);
  });
});

describe('the validity state survives resolution, overrides and a saved session', () => {
  const invalid = crsFromWkt(wkt1Compound('UNIT["degree",0.0174532925199433]', ',AUTHORITY["EPSG","5703"]'));
  const yard = crsFromWkt(wkt1Compound('UNIT["yard",0.9144]'));

  it('a saved session restores an invalid vertical unit as invalid, never absent', () => {
    const resolved = resolvedFromCrsInfo(invalid, 'las-vlr')!;
    // JSON writes the non-finite factor as null.
    const reloaded = parseResolvedCrs(JSON.parse(JSON.stringify(resolved)))!;
    expect(spatialContextFrom(reloaded).verticalScaleState).toBe('invalid');
    expect(verticalMetresPerUnit(spatialContextFrom(reloaded), 'horizontal')).toBeUndefined();
    // A token-only record (the factor key dropped entirely) is invalid as well.
    const { verticalUnitToMetres: _dropped, ...tokenOnly } = JSON.parse(JSON.stringify(resolved)) as Record<string, unknown>;
    expect(spatialContextFrom(parseResolvedCrs(tokenOnly)!).verticalScaleState).toBe('invalid');
  });

  it('a saved session keeps a valid non-named factor', () => {
    const reloaded = parseResolvedCrs(JSON.parse(JSON.stringify(resolvedFromCrsInfo(yard, 'las-vlr'))))!;
    expect(reloaded.verticalUnitToMetres).toBe(0.9144);
    expect(spatialContextFrom(reloaded).verticalScaleState).toBe('valid');
  });

  it('a horizontal override keeps the detected vertical validity', () => {
    const identity = { pointCount: 1000, extent: [10, 10, 1] as [number, number, number], min: [100, 200, 0] as [number, number, number] };
    const override = { epsg: 32612, kind: 'projected' as const, updatedAt: 1, detectedEpsg: 32613, detectedEpsgObserved: true, identity, identityVersion: 2 };
    const svc = new CrsService({ get: () => override, set: () => undefined, clear: () => undefined });
    svc.resolveForScan({ name: 'v.las', detected: invalid, source: 'las-vlr', identity });
    expect(svc.current()?.source).toBe('user-override');
    expect(svc.context().verticalScaleState).toBe('invalid');
  });
});
