/**
 * wktParser.test.ts
 *
 * Table-driven tests for the WKT AST tokenizer/parser and the fields
 * `crsFromWkt` derives from it. Two contracts:
 *
 *   1. The parser turns `KEYWORD["name", child, …]` WKT into a faithful tree —
 *      quoted strings, numbers, bare keyword tokens (axis directions) and nested
 *      nodes — for WKT1 and WKT2 shapes, and degrades (never throws) on junk.
 *   2. `crsFromWkt` reads the SAME `CrsInfo` from that tree the regex parser did:
 *      name / EPSG / linear unit / datum / compound horizontal slice, with the
 *      no-UNIT→metre default and the unknown-unit→unknown fail-closed preserved.
 *
 * Pure Node — no DOM, no three.js.
 */

import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import {
  collectWktNodes,
  parseWkt,
  wktChildNodes,
  wktFirstNumber,
  wktNodeName,
  type WktNode,
} from '../src/io/wktParser';

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer / AST shape
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWkt — AST node shape', () => {
  it('parses a keyword, quoted name, number, and nested node', () => {
    const root = parseWkt('UNIT["metre",1,AUTHORITY["EPSG","9001"]]');
    expect(root).not.toBeNull();
    expect(root!.keyword).toBe('UNIT');
    expect(wktNodeName(root!)).toBe('metre');
    expect(wktFirstNumber(root!)).toBe(1);
    const auth = wktChildNodes(root!);
    expect(auth).toHaveLength(1);
    expect(auth[0].keyword).toBe('AUTHORITY');
    expect(wktNodeName(auth[0])).toBe('EPSG');
  });

  it('uppercases keywords so matching is case-insensitive', () => {
    const root = parseWkt('projcs["x",unit["metre",1]]');
    expect(root!.keyword).toBe('PROJCS');
    expect(wktChildNodes(root!)[0].keyword).toBe('UNIT');
  });

  it('keeps a bare identifier (axis direction) as a keyword child, not a node', () => {
    const root = parseWkt('AXIS["Gravity-related height",UP]');
    // The name is the quoted string; UP is a bare keyword token (no brackets).
    expect(wktNodeName(root!)).toBe('Gravity-related height');
    expect(wktChildNodes(root!)).toHaveLength(0); // UP is not a node
    const kinds = root!.children.map((c) => c.type);
    expect(kinds).toEqual(['string', 'keyword']);
  });

  it('reads signed and scientific numeric literals', () => {
    const root = parseWkt('PARAMETER["central_meridian",-111]');
    expect(wktFirstNumber(root!)).toBe(-111);
    const sci = parseWkt('P["x",1.5e-7]');
    expect(wktFirstNumber(sci!)).toBeCloseTo(1.5e-7, 12);
  });

  it('reads WKT2 unquoted authority codes (ID["EPSG",32612]) as numbers', () => {
    const root = parseWkt('ID["EPSG",32612]');
    expect(wktNodeName(root!)).toBe('EPSG');
    expect(wktFirstNumber(root!)).toBe(32612);
  });

  it('collectWktNodes walks the whole tree in document order', () => {
    const root = parseWkt('PROJCS["p",GEOGCS["g",DATUM["d"]],UNIT["metre",1]]');
    const keywords = collectWktNodes(root!).map((n: WktNode) => n.keyword);
    expect(keywords).toEqual(['PROJCS', 'GEOGCS', 'DATUM', 'UNIT']);
  });

  it('returns null when there is no node at all', () => {
    expect(parseWkt('')).toBeNull();
    expect(parseWkt('    ')).toBeNull();
    expect(parseWkt('not wkt at all')).toBeNull();
  });

  it('degrades without throwing on an unterminated bracket', () => {
    const root = parseWkt('PROJCS["Unterminated",GEOGCS["base"');
    expect(root).not.toBeNull();
    expect(root!.keyword).toBe('PROJCS');
    expect(wktNodeName(root!)).toBe('Unterminated');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// crsFromWkt — table-driven field derivation
// ─────────────────────────────────────────────────────────────────────────────

const NAD83_SP_CA_V_WKT =
  'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",' +
  'DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
  'PROJECTION["Lambert_Conformal_Conic_2SP"],' +
  'UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],' +
  'AUTHORITY["EPSG","2229"]]';

interface Case {
  readonly title: string;
  readonly wkt: string;
  readonly epsg?: number;
  readonly isGeographic: boolean;
  readonly linearUnit: 'metre' | 'foot' | 'us-survey-foot' | 'unknown';
  readonly nameContains?: string;
  readonly horizontalDatum?: string;
  readonly verticalEpsg?: number;
  readonly verticalDatumContains?: string;
  readonly verticalLinearUnit?: 'metre' | 'foot' | 'us-survey-foot' | 'unknown';
}

const cases: Case[] = [
  {
    title: 'WKT1 projected metre (UTM 12N)',
    wkt: 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984"],UNIT["degree",0.0174532925199433]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","32612"]]',
    epsg: 32612, isGeographic: false, linearUnit: 'metre',
    nameContains: 'WGS 84 / UTM zone 12N', horizontalDatum: 'WGS 84',
  },
  {
    title: 'WKT1 projected US survey foot (state plane)',
    wkt: NAD83_SP_CA_V_WKT,
    epsg: 2229, isGeographic: false, linearUnit: 'us-survey-foot', horizontalDatum: 'NAD83',
  },
  {
    title: 'WKT2 projected (PROJCRS + ID + BASEGEOGCRS + LENGTHUNIT)',
    wkt: 'PROJCRS["WGS 84 / UTM zone 12N",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984"],ID["EPSG",4326]],CONVERSION["UTM zone 12N"],CS[Cartesian,2],AXIS["easting",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["northing",north,ORDER[2],LENGTHUNIT["metre",1]],ID["EPSG",32612]]',
    // LENGTHUNIT is deliberately NOT read as a linear UNIT (parity with the old
    // parser); with no bare UNIT clause a projected CRS defaults to metre.
    epsg: 32612, isGeographic: false, linearUnit: 'metre',
    nameContains: 'WGS 84 / UTM zone 12N', horizontalDatum: 'WGS 84',
  },
  {
    title: 'geographic (WKT1 GEOGCS, degrees)',
    wkt: 'GEOGCS["WGS 84",DATUM["WGS_1984"],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]',
    epsg: 4326, isGeographic: true, linearUnit: 'unknown', horizontalDatum: 'WGS 84',
  },
  {
    title: 'nested base preserves datum realization (NAD83(2011))',
    wkt: 'PROJCS["NAD83(2011) / UTM zone 12N",GEOGCS["NAD83(2011)",DATUM["NAD83_2011"]],UNIT["metre",1]]',
    isGeographic: false, linearUnit: 'metre', horizontalDatum: 'NAD83(2011)',
  },
  {
    title: 'compound: horizontal foot unit beats vertical metres',
    wkt: 'COMPD_CS["NAD83 SP + NAVD88",' + NAD83_SP_CA_V_WKT +
      ',VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005],' +
      'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5703"]]]',
    epsg: 2229, isGeographic: false, linearUnit: 'us-survey-foot',
    verticalEpsg: 5703, verticalDatumContains: 'NAVD88', verticalLinearUnit: 'metre',
  },
  {
    title: 'compound: vertical survey-foot over a metre grid, read separately',
    wkt: 'COMPD_CS["c",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984"],UNIT["degree",0.0174532925199433]],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["NAVD88",2005],UNIT["US survey foot",0.3048006096012192],AUTHORITY["EPSG","6360"]]]',
    epsg: 32612, isGeographic: false, linearUnit: 'metre',
    verticalDatumContains: 'NAVD88', verticalLinearUnit: 'us-survey-foot',
  },
  {
    title: 'compound: explicit vertical EPSG with an unrecognised datum name',
    wkt: 'COMPD_CS["x",PROJCS["NAD83 / UTM zone 11N",AUTHORITY["EPSG","26911"]],VERT_CS["Some local height datum",VERT_DATUM["Local",2005,AUTHORITY["EPSG","1234"]],UNIT["metre",1],AUTHORITY["EPSG","5703"]]]',
    epsg: 26911, isGeographic: false, linearUnit: 'metre',
    verticalEpsg: 5703, verticalDatumContains: 'Some local height datum',
  },
  {
    title: 'standalone vertical CRS (no horizontal)',
    wkt: 'VERT_CS["NAVD88 height",VERT_DATUM["NAVD88",2005],UNIT["metre",1],AUTHORITY["EPSG","5703"]]',
    epsg: undefined, isGeographic: false, linearUnit: 'metre',
    verticalEpsg: 5703, verticalDatumContains: 'NAVD88',
  },
  {
    title: 'missing UNIT on a projected CRS defaults to metre',
    wkt: 'PROJCS["Local grid",AUTHORITY["EPSG","0"]]',
    // EPSG:0 is below the accepted range → no code claimed.
    epsg: undefined, isGeographic: false, linearUnit: 'metre',
  },
  {
    title: 'unknown unit NAME resolves to unknown (fail-closed), scale kept',
    wkt: 'PROJCS["Local grid",UNIT["chain",20.1168],AUTHORITY["EPSG","0"]]',
    epsg: undefined, isGeographic: false, linearUnit: 'unknown',
  },
  {
    title: 'nested UNIT authority is not mistaken for the CRS code',
    wkt: 'PROJCS["Custom Zone",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]]]',
    epsg: undefined, isGeographic: false, linearUnit: 'metre', horizontalDatum: 'WGS 84',
  },
];

describe('crsFromWkt — table-driven shapes (parity with the regex parser)', () => {
  for (const c of cases) {
    it(c.title, () => {
      const crs = crsFromWkt(c.wkt);
      expect(crs.source).toBe('wkt');
      expect(crs.epsg).toBe(c.epsg);
      expect(crs.isGeographic).toBe(c.isGeographic);
      expect(crs.linearUnit).toBe(c.linearUnit);
      if (c.nameContains) expect(crs.name).toContain(c.nameContains);
      if (c.horizontalDatum !== undefined) expect(crs.horizontalDatum).toBe(c.horizontalDatum);
      if (c.verticalEpsg !== undefined) expect(crs.verticalEpsg).toBe(c.verticalEpsg);
      if (c.verticalDatumContains) expect(crs.verticalDatum).toContain(c.verticalDatumContains);
      if (c.verticalLinearUnit !== undefined) expect(crs.verticalLinearUnit).toBe(c.verticalLinearUnit);
    });
  }
});

describe('crsFromWkt — malformed input falls back like the regex parser did', () => {
  it('empty / whitespace / junk → Unknown CRS, no code, metre default off (unknown)', () => {
    for (const bad of ['', '   ', 'not wkt at all']) {
      const crs = crsFromWkt(bad);
      expect(crs.name).toBe('Unknown CRS');
      expect(crs.epsg).toBeUndefined();
      expect(crs.isGeographic).toBe(false);
      // No PROJCS/GEOGCS recognised → not geographic; the projected branch with
      // no UNIT defaults to metre, matching the prior parser exactly.
      expect(crs.linearUnit).toBe('metre');
    }
  });

  it('an unterminated PROJCS still yields its name and defaults', () => {
    const crs = crsFromWkt('PROJCS["Unterminated",GEOGCS["base"');
    expect(crs.name).toBe('Unterminated');
    expect(crs.epsg).toBeUndefined();
    expect(crs.isGeographic).toBe(false);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.horizontalDatum).toBe('base');
  });

  it('trailing NUL terminators are trimmed before parsing', () => {
    const crs = crsFromWkt('PROJCS["Zone",UNIT["metre",1],AUTHORITY["EPSG","32612"]]\0\0');
    expect(crs.epsg).toBe(32612);
    expect(crs.wkt?.endsWith(']')).toBe(true);
  });
});
