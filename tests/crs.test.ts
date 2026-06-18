/**
 * crs.test.ts — v0.3.2-Georef CRS parser unit tests.
 *
 * Pins the research-grade contracts:
 *   • WKT parser extracts CRS name + EPSG + linear unit correctly for the
 *     three common cases (UTM metres, state-plane US-survey-feet, WGS 84).
 *   • Linear-unit scale conversion produces TRUE METRES, not approximations.
 *   • `parseCrsFromVlrs` round-trips a hand-rolled VLR list, including the
 *     graceful-null path for malformed / truncated buffers.
 *
 * Pure Node — no DOM, no three.js.
 */

import { test, expect } from 'vitest';
import {
  crsFromWkt,
  crsFromEpsg,
  linearUnitLabel,
  parseCrsFromVlrs,
  toMetres,
} from '../src/io/crs';

// ─────────────────────────────────────────────────────────────────────────────
// WKT — projected metric (UTM)
// ─────────────────────────────────────────────────────────────────────────────

const UTM12N_WKT =
  'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
  'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],' +
  'AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],' +
  'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-111],' +
  'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],' +
  'PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],' +
  'AUTHORITY["EPSG","32612"]]';

test('crsFromWkt — UTM 12N — name + EPSG + metric units', () => {
  const crs = crsFromWkt(UTM12N_WKT);
  expect(crs.source).toBe('wkt');
  expect(crs.name).toContain('WGS 84 / UTM zone 12N');
  expect(crs.epsg).toBe(32612);
  expect(crs.linearUnit).toBe('metre');
  expect(crs.linearUnitToMetres).toBe(1);
  expect(crs.isGeographic).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// WKT — projected, US survey foot (state plane)
// ─────────────────────────────────────────────────────────────────────────────

// State Plane California Zone V (NAD83), EPSG:2229 — US survey feet.
const NAD83_SP_CA_V_WKT =
  'PROJCS["NAD83 / California zone 5 (ftUS)",GEOGCS["NAD83",' +
  'DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
  'PROJECTION["Lambert_Conformal_Conic_2SP"],' +
  'PARAMETER["standard_parallel_1",35.46666666666667],' +
  'PARAMETER["standard_parallel_2",34.03333333333333],' +
  'PARAMETER["latitude_of_origin",33.5],PARAMETER["central_meridian",-118],' +
  'PARAMETER["false_easting",6561666.667],PARAMETER["false_northing",1640416.667],' +
  'UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],' +
  'AUTHORITY["EPSG","2229"]]';

test('crsFromWkt — State Plane CA V — US survey-foot detection', () => {
  const crs = crsFromWkt(NAD83_SP_CA_V_WKT);
  expect(crs.epsg).toBe(2229);
  expect(crs.linearUnit).toBe('us-survey-foot');
  // The US survey foot is exactly 1200/3937 metres ≈ 0.3048006096012192.
  expect(crs.linearUnitToMetres).toBeCloseTo(1200 / 3937, 10);
  expect(crs.isGeographic).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// WKT — projected, international foot
// ─────────────────────────────────────────────────────────────────────────────

const INTL_FT_WKT =
  'PROJCS["Custom Zone (ft)",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],' +
  'UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],' +
  'UNIT["foot",0.3048,AUTHORITY["EPSG","9002"]],AUTHORITY["EPSG","12345"]]';

test('crsFromWkt — international foot detection', () => {
  const crs = crsFromWkt(INTL_FT_WKT);
  expect(crs.linearUnit).toBe('foot');
  expect(crs.linearUnitToMetres).toBeCloseTo(0.3048, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
// WKT — compound (horizontal + vertical) — the unit must come from the
// HORIZONTAL slice. The vertical block almost always carries UNIT["metre",1],
// and v0.4.3 scanned the full text so that metre clause won over the
// horizontal US-survey-foot one.
// ─────────────────────────────────────────────────────────────────────────────

// State Plane CA V in US survey feet + NAVD88 height in metres.
const COMPD_SP_FTUS_NAVD88_M_WKT =
  'COMPD_CS["NAD83 / California zone 5 (ftUS) + NAVD88 height",' +
  NAD83_SP_CA_V_WKT +
  ',VERT_CS["NAVD88 height",VERT_DATUM["North American Vertical Datum 1988",2005,' +
  'AUTHORITY["EPSG","5103"]],UNIT["metre",1,AUTHORITY["EPSG","9001"]],' +
  'AXIS["Gravity-related height",UP],AUTHORITY["EPSG","5703"]]]';

test('crsFromWkt — COMPD_CS: horizontal survey-foot unit beats vertical metres', () => {
  const crs = crsFromWkt(COMPD_SP_FTUS_NAVD88_M_WKT);
  expect(crs.epsg).toBe(2229);
  // The horizontal unit is the US survey foot — the vertical block's
  // UNIT["metre",1] must NOT win just because it appears later in the text.
  expect(crs.linearUnit).toBe('us-survey-foot');
  expect(crs.linearUnitToMetres).toBeCloseTo(0.3048006096012192, 10);
  // The vertical datum is still parsed from the vertical block.
  expect(crs.verticalDatum).toContain('NAVD88');
  // …and the Z-axis unit is read from the vertical block (metres here) SEPARATELY
  // from the horizontal foot unit — so elevation converts by its own unit.
  expect(crs.verticalLinearUnit).toBe('metre');
  expect(crs.verticalUnitToMetres).toBe(1);
});

// Reverse cross-unit case: metre grid + NAVD88 height in US survey feet.
const COMPD_M_NAVD88_FTUS_WKT =
  'COMPD_CS["WGS 84 / UTM 12N + NAVD88 height (ftUS)",' +
  'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984"],' +
  'UNIT["degree",0.0174532925199433]],UNIT["metre",1],AUTHORITY["EPSG","32612"]],' +
  'VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["NAVD88",2005],' +
  'UNIT["US survey foot",0.3048006096012192,AUTHORITY["EPSG","9003"]],' +
  'AUTHORITY["EPSG","6360"]]]';

test('crsFromWkt — vertical UNIT in survey feet over a metre grid is read on its own', () => {
  const crs = crsFromWkt(COMPD_M_NAVD88_FTUS_WKT);
  expect(crs.linearUnit).toBe('metre'); // horizontal grid is metres
  expect(crs.linearUnitToMetres).toBe(1);
  expect(crs.verticalLinearUnit).toBe('us-survey-foot'); // Z is feet
  expect(crs.verticalUnitToMetres).toBeCloseTo(0.3048006096012192, 10);
  expect(crs.verticalDatum).toContain('NAVD88');
});

// ─────────────────────────────────────────────────────────────────────────────
// WKT — geographic (degrees)
// ─────────────────────────────────────────────────────────────────────────────

const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]';

test('crsFromWkt — geographic CRS flagged correctly', () => {
  const crs = crsFromWkt(WGS84_WKT);
  expect(crs.isGeographic).toBe(true);
  expect(crs.epsg).toBe(4326);
  // Linear unit doesn't apply to a geographic CRS; the parser returns
  // `unknown` so measurement code falls back safely.
  expect(crs.linearUnit).toBe('unknown');
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit conversion — `toMetres` is what the measurement tool calls.
// ─────────────────────────────────────────────────────────────────────────────

test('toMetres — metres pass through unchanged', () => {
  const crs = crsFromWkt(UTM12N_WKT);
  expect(toMetres(15.25, crs)).toBe(15.25);
});

test('toMetres — US survey feet convert exactly', () => {
  const crs = crsFromWkt(NAD83_SP_CA_V_WKT);
  // 100 US survey feet = 100 × 1200/3937 m ≈ 30.4800609601 m.
  expect(toMetres(100, crs)).toBeCloseTo(100 * (1200 / 3937), 10);
});

test('toMetres — international feet convert exactly', () => {
  const crs = crsFromWkt(INTL_FT_WKT);
  expect(toMetres(100, crs)).toBeCloseTo(30.48, 10);
});

test('toMetres — null CRS passes value through', () => {
  expect(toMetres(42, null)).toBe(42);
});

// ─────────────────────────────────────────────────────────────────────────────
// VLR parser — round-trip a hand-rolled buffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a buffer containing N VLRs starting at the given offset. Each VLR
 * is 54-byte header + payload. Mirrors the on-disk LAS VLR layout.
 */
function buildVlrBuffer(
  vlrs: Array<{ userId: string; recordId: number; payload: Uint8Array }>,
  startOffset = 0,
): { buffer: ArrayBuffer; vlrStart: number; count: number } {
  let total = startOffset;
  for (const v of vlrs) total += 54 + v.payload.byteLength;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  let cursor = startOffset;
  for (const v of vlrs) {
    // userId at offset 2, 16 bytes ASCII
    for (let i = 0; i < Math.min(16, v.userId.length); i++) {
      bytes[cursor + 2 + i] = v.userId.charCodeAt(i);
    }
    view.setUint16(cursor + 18, v.recordId, true);
    view.setUint16(cursor + 20, v.payload.byteLength, true);
    bytes.set(v.payload, cursor + 54);
    cursor += 54 + v.payload.byteLength;
  }
  return { buffer, vlrStart: startOffset, count: vlrs.length };
}

test('parseCrsFromVlrs — returns null for an empty VLR list', () => {
  const { buffer } = buildVlrBuffer([], 100);
  expect(parseCrsFromVlrs(buffer, 100, 0)).toBeNull();
});

test('parseCrsFromVlrs — finds an OGC WKT VLR and extracts EPSG', () => {
  const wktBytes = new TextEncoder().encode(UTM12N_WKT + '\0');
  const { buffer, vlrStart, count } = buildVlrBuffer(
    [{ userId: 'LASF_Projection', recordId: 2112, payload: wktBytes }],
    100,
  );
  const crs = parseCrsFromVlrs(buffer, vlrStart, count);
  expect(crs).not.toBeNull();
  expect(crs?.source).toBe('wkt');
  expect(crs?.epsg).toBe(32612);
  expect(crs?.linearUnit).toBe('metre');
});

test('parseCrsFromVlrs — ignores non-LASF_Projection VLRs', () => {
  const { buffer, vlrStart, count } = buildVlrBuffer(
    [{ userId: 'OTHER_VENDOR', recordId: 2112, payload: new Uint8Array([0]) }],
    100,
  );
  expect(parseCrsFromVlrs(buffer, vlrStart, count)).toBeNull();
});

test('parseCrsFromVlrs — gracefully returns null on truncated buffer', () => {
  // A "buffer" that promises 5 VLRs but only has bytes for one header.
  const buffer = new ArrayBuffer(100);
  expect(parseCrsFromVlrs(buffer, 50, 5)).toBeNull();
});

// ─────────────────────────────────────────────────────────────────────────────
// Display helpers
// ─────────────────────────────────────────────────────────────────────────────

test('linearUnitLabel covers every variant with a short label', () => {
  expect(linearUnitLabel('metre')).toBe('metres');
  expect(linearUnitLabel('foot')).toBe('international ft');
  expect(linearUnitLabel('us-survey-foot')).toBe('US survey ft');
  expect(linearUnitLabel('unknown')).toBe('unknown');
});

// ─────────────────────────────────────────────────────────────────────────────
// crsFromEpsg — code-based CRS (EPT srs without WKT)
// ─────────────────────────────────────────────────────────────────────────────

test('crsFromEpsg — projected code defaults to metres, carries the EPSG', () => {
  const c = crsFromEpsg(32612);
  expect(c.source).toBe('epsg');
  expect(c.epsg).toBe(32612);
  expect(c.name).toBe('EPSG:32612');
  expect(c.isGeographic).toBe(false);
  expect(c.linearUnit).toBe('metre');
  expect(c.linearUnitToMetres).toBe(1);
  expect(c.verticalDatum).toBeUndefined();
});

test('crsFromEpsg — geographic code reports degrees (unit unknown)', () => {
  const c = crsFromEpsg(4326, { isGeographic: true });
  expect(c.isGeographic).toBe(true);
  expect(c.linearUnit).toBe('unknown');
});

test('crsFromEpsg — a real vertical code resolves to a known datum name', () => {
  const c = crsFromEpsg(32612, { verticalEpsg: 5703 });
  expect(c.verticalEpsg).toBe(5703);
  expect(c.verticalDatum).toBe('NAVD88');
});

test('crsFromEpsg — an unknown vertical code falls back to EPSG:<code>', () => {
  const c = crsFromEpsg(32612, { verticalEpsg: 9999 });
  expect(c.verticalEpsg).toBe(9999);
  expect(c.verticalDatum).toBe('EPSG:9999');
});

test('crsFromEpsg — placeholder vertical codes (0 / 32767) are rejected', () => {
  expect(crsFromEpsg(32612, { verticalEpsg: 0 }).verticalDatum).toBeUndefined();
  expect(crsFromEpsg(32612, { verticalEpsg: 32767 }).verticalDatum).toBeUndefined();
});
