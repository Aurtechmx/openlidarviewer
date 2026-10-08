/**
 * demGeoTiffVerticalCrs.test.ts — the vertical GeoKeys a DTM or DSM GeoTIFF
 * carries, and the files that must not change because of them.
 *
 * Two rules from OGC 19-008r4 (GeoTIFF 1.1) drive these tests:
 *
 * - Requirement 2.9: a file that uses keys GeoTIFF 1.0 does not cover, such as
 *   VerticalGeoKey (4096), declares MinorRevision 1. GDAL reads the vertical
 *   part of a 1.0 file only when GTIFF_REPORT_COMPD_CS is set, so a 1.0 header
 *   loses the vertical CRS under a default read.
 * - A vertical CRS code has its own axis unit. GDAL takes the unit from the
 *   code and ignores VerticalUnitsGeoKey (4099), so 5703 with 4099 = US survey
 *   foot reads as metres. The code written must be the one whose unit matches
 *   the heights.
 *
 * The EPSG codes used here were checked against the EPSG registry with pyproj
 * 3.7.2 (PROJ 9.8.1); `demGeoTiffGdal.test.ts` repeats that check with
 * `projinfo` wherever GDAL is installed.
 */

import { describe, it, expect } from 'vitest';
import {
  writeGeoTiff,
  resolveVerticalGeoKeys,
  GeoTiffVerticalCrsConflictError,
  type DemGeoTiffInput,
} from '../src/terrain/export/demGeoTiff';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import { buildContourDeliverableFromResult } from '../src/terrain/export/contourDeliverableBuild';
import { DTM_CLAIMS, validatedDecision } from './helpers/exportDecisions';
import { sha256Hex } from '../src/terrain/export/sha256';
import { extractEntry } from './helpers/zipReader';
import { DEM_PKG_OPTS, demResultFor } from './helpers/demPackageFixture';
import type { SensitivityMemberGrid } from '../src/terrain/export/demSensitivity';

const GEO_KEY_DIRECTORY = 34735;
const GDAL_METADATA = 42112;

/** Parse the first IFD into tag -> { type, count, offset-or-inline }. */
function fields(bytes: Uint8Array): Map<number, { type: number; count: number; value: number }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const out = new Map<number, { type: number; count: number; value: number }>();
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    out.set(dv.getUint16(p, true), {
      type: dv.getUint16(p + 2, true),
      count: dv.getUint32(p + 4, true),
      value: dv.getUint32(p + 8, true),
    });
  }
  return out;
}

/** The GeoKey directory: its four-value header and a key -> value map. */
function geoKeys(bytes: Uint8Array): { header: number[]; keys: Map<number, number> } {
  const f = fields(bytes).get(GEO_KEY_DIRECTORY)!;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = Array.from({ length: f.count }, (_, i) => dv.getUint16(f.value + i * 2, true));
  const header = u16.slice(0, 4);
  const keys = new Map<number, number>();
  for (let k = 0; k < header[3]; k++) {
    const e = u16.slice(4 + k * 4, 8 + k * 4);
    keys.set(e[0], e[3]);
  }
  return { header, keys };
}

/** The GDAL_METADATA XML, or null when the file carries none. */
function gdalMetadata(bytes: Uint8Array): string | null {
  const f = fields(bytes).get(GDAL_METADATA);
  if (!f) return null;
  return new TextDecoder().decode(bytes.subarray(f.value, f.value + f.count)).replace(/\0+$/, '');
}

const base: DemGeoTiffInput = {
  values: Float32Array.from([1, 2, 3, 4]),
  coverage: Uint8Array.from([1, 1, 1, 1]),
  cols: 2, rows: 2, cellSize: 1, xllCorner: 500_000, yllCorner: 4_500_000,
  epsg: 32612, isGeographic: false,
};

describe('GeoKey directory revision', () => {
  it('declares GeoTIFF 1.1 when VerticalGeoKey is written', () => {
    const { header, keys } = geoKeys(writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9001 }));
    expect(header).toEqual([1, 1, 1, 5]);
    expect(keys.get(4096)).toBe(5703);
    expect(keys.get(4099)).toBe(9001);
  });

  it('keeps GeoTIFF 1.0 when no vertical key is written', () => {
    const { header, keys } = geoKeys(writeGeoTiff(base));
    expect(header).toEqual([1, 1, 0, 3]);
    expect(keys.has(4096)).toBe(false);
  });

  it('keeps GeoTIFF 1.0 for an unplaced raster', () => {
    const { header } = geoKeys(writeGeoTiff({ ...base, epsg: null }));
    expect(header).toEqual([1, 1, 0, 2]);
  });
});

describe('VerticalGeoKey agrees with the height unit', () => {
  it('writes NAVD88 in US survey feet as EPSG:6360', () => {
    const { header, keys } = geoKeys(writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9003 }));
    expect(header[2]).toBe(1);
    expect(keys.get(4096)).toBe(6360);
    expect(keys.get(4099)).toBe(9003);
  });

  it('writes NAVD88 in international feet as EPSG:8228', () => {
    const { keys } = geoKeys(writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: 9002 }));
    expect(keys.get(4096)).toBe(8228);
    expect(keys.get(4099)).toBe(9002);
  });

  it('keeps a foot-defined code when the unit matches it', () => {
    const { keys } = geoKeys(writeGeoTiff({ ...base, verticalEpsg: 6360, verticalUnitCode: 9003 }));
    expect(keys.get(4096)).toBe(6360);
  });

  it('maps the NAVD88 datum code to the vertical CRS in the declared unit', () => {
    expect(resolveVerticalGeoKeys(5103, 9001)).toMatchObject({ status: 'written', epsg: 5703 });
    expect(resolveVerticalGeoKeys(5103, 9003)).toMatchObject({ status: 'written', epsg: 6360 });
  });

  it('refuses a code whose own unit contradicts the declared unit', () => {
    expect(() => writeGeoTiff({ ...base, verticalEpsg: 6360, verticalUnitCode: 9001 }))
      .toThrow(GeoTiffVerticalCrsConflictError);
    expect(() => writeGeoTiff({ ...base, verticalEpsg: 8228, verticalUnitCode: 9003 }))
      .toThrow(GeoTiffVerticalCrsConflictError);
    try {
      writeGeoTiff({ ...base, verticalEpsg: 6360, verticalUnitCode: 9001 });
    } catch (e) {
      const err = e as GeoTiffVerticalCrsConflictError;
      expect(err.verticalEpsg).toBe(6360);
      expect(err.verticalUnitCode).toBe(9001);
      expect(err.message).toMatch(/EPSG:6360/);
    }
  });

  it('leaves the vertical CRS off when EPSG has no code in the declared unit', () => {
    const bytes = writeGeoTiff({ ...base, verticalEpsg: 3855, verticalUnitCode: 9002 });
    const { header, keys } = geoKeys(bytes);
    expect(keys.has(4096)).toBe(false);
    expect(keys.has(4099)).toBe(false);
    expect(header[2]).toBe(0);
    expect(gdalMetadata(bytes)).toContain('<Item name="UNITTYPE" sample="0" role="unittype">foot</Item>');
  });

  it('leaves an unverified vertical code off and keeps the unit as UNITTYPE', () => {
    const bytes = writeGeoTiff({ ...base, verticalEpsg: 12345, verticalUnitCode: 9001 });
    expect(geoKeys(bytes).keys.has(4096)).toBe(false);
    expect(gdalMetadata(bytes)).toContain('>metre</Item>');
    expect(resolveVerticalGeoKeys(12345, 9001)).toMatchObject({ status: 'omitted', reason: 'unverified-code' });
  });

  it('leaves the vertical CRS off when the height unit is unknown', () => {
    const bytes = writeGeoTiff({ ...base, verticalEpsg: 5703, verticalUnitCode: null });
    expect(geoKeys(bytes).keys.has(4096)).toBe(false);
    expect(gdalMetadata(bytes)).toBeNull();
  });

  it('leaves a depth CRS off a height raster', () => {
    for (const [code, unit] of [[6357, 9001], [6358, 9003], [5715, 9001], [5612, 9001]] as const) {
      const bytes = writeGeoTiff({ ...base, verticalEpsg: code, verticalUnitCode: unit });
      expect(geoKeys(bytes).keys.has(4096), `EPSG:${code}`).toBe(false);
      expect(resolveVerticalGeoKeys(code, unit)).toMatchObject({ status: 'omitted', reason: 'depth-axis' });
    }
  });

  it('never replaces an explicit band unit', () => {
    const bytes = writeGeoTiff({
      ...base,
      values: undefined,
      bands: [{ values: Float32Array.from([1, 2, 3, 4]), unit: 'm above ground' }],
      verticalEpsg: 3855,
      verticalUnitCode: 9002,
    });
    const xml = gdalMetadata(bytes)!;
    expect(xml).toContain('>m above ground</Item>');
    expect(xml).not.toContain('>foot</Item>');
  });
});

describe('rasters without a vertical key keep their bytes', () => {
  // The contour deliverable's Support raster: a uint8 class map, no vertical
  // CRS, so its bytes are pinned.
  it('writes the Support raster layout byte-identically', () => {
    const bytes = writeGeoTiff({
      values: Uint8Array.from([0, 1, 2, 2]),
      coverage: Uint8Array.from([1, 1, 1, 1]),
      cols: 2, rows: 2, cellSize: 1, xllCorner: 500_000, yllCorner: 4_500_000,
      noData: 255, epsg: 32612, isGeographic: false, band: 'uint8',
    });
    expect(sha256Hex(bytes)).toBe('231d34150c4830fe105190b3158cc0cd4e6c467d24346528756fc339667b9131');
  });
});

describe('placement is unchanged', () => {
  it('writes north row first from an upper-left tiepoint with two-unit cells', () => {
    // Grid rows are south first: row 0 = [11, hole], row 1 = [21, 22].
    const bytes = writeGeoTiff({
      values: Float32Array.from([11, 99, 21, 22]),
      coverage: Uint8Array.from([2, 0, 2, 2]),
      cols: 2, rows: 2, cellSize: 2, xllCorner: 100, yllCorner: 200,
      epsg: 32612, verticalEpsg: 5703, verticalUnitCode: 9001,
    });
    const f = fields(bytes);
    const dv = new DataView(bytes.buffer);
    const strip = Array.from({ length: 4 }, (_, i) => dv.getFloat32(f.get(273)!.value + i * 4, true));
    expect(strip).toEqual([21, 22, 11, -9999]);
    const tie = f.get(33922)!.value;
    expect([dv.getFloat64(tie + 24, true), dv.getFloat64(tie + 32, true)]).toEqual([100, 204]);
    const scale = f.get(33550)!.value;
    expect([dv.getFloat64(scale, true), dv.getFloat64(scale + 8, true)]).toEqual([2, 2]);
  });
});

// ── the DEM package ─────────────────────────────────────────────────────────

const COLS = 6;
const ROWS = 4;
const N = COLS * ROWS;

function grid() {
  const z = new Float32Array(N);
  for (let i = 0; i < N; i++) z[i] = (i % COLS) < 3 ? 100 : 101;
  return {
    z,
    counts: new Uint32Array(N).fill(3),
    coverage: new Uint8Array(N).fill(2),
    confidence: new Float32Array(N).fill(100),
    interpDistanceCells: new Float32Array(N),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
  };
}

function members(g: ReturnType<typeof grid>): SensitivityMemberGrid[] {
  const moved = Float32Array.from(g.z, (v, i) => (i % COLS === 5 ? v + 0.4 : v));
  const b = { coverage: g.coverage, cols: g.cols, rows: g.rows, cellSizeM: 1, originH1: 0, originH2: 0 };
  return [{ ...b, z: g.z }, { ...b, z: moved }, { ...b, z: g.z }, { ...b, z: g.z }];
}

/** A package whose DTM declares `verticalEpsg` with heights `metresPerUnit` metres each. */
function pkg(verticalEpsg: number | null, metresPerUnit: number) {
  const g = grid();
  const result = demResultFor(g, metresPerUnit);
  (result.dtm as { verticalEpsg: number | null }).verticalEpsg = verticalEpsg;
  // A canopy over half the cells, so the CHM carries real values.
  (result.surface.canopy as { heightM: Float32Array }).heightM = Float32Array.from({ length: N }, (_, i) => (i % 2 ? 3.5 : Number.NaN));
  const zip = buildDemPackage(result, {
    ...DEM_PKG_OPTS,
    verticalUnitToMetres: metresPerUnit,
    sensitivityGrids: members(g),
    attention: true,
  });
  const get = (name: string) => extractEntry(zip, name)!;
  return { get, readme: new TextDecoder().decode(get('terrain-README.txt')) };
}

const US_FT = 1200 / 3937;

describe('DEM package vertical keys', () => {
  it('writes the DTM and DSM as NAVD88 height (ftUS) for a US survey foot source', () => {
    const p = pkg(5703, US_FT);
    for (const k of ['dtm', 'dsm']) {
      const { header, keys } = geoKeys(p.get(`terrain-${k}.tif`));
      expect(header[2]).toBe(1);
      expect(keys.get(4096)).toBe(6360);
      expect(keys.get(4099)).toBe(9003);
    }
    expect(p.readme).toMatch(/Vertical CRS\s+EPSG:6360/);
  });

  it('writes no vertical key on the CHM', () => {
    const { header, keys } = geoKeys(pkg(5703, 1).get('terrain-chm.tif'));
    expect(keys.has(4096)).toBe(false);
    expect(header[2]).toBe(0);
  });

  it('turns a contradictory source into a README note and a DTM without a vertical CRS', () => {
    const p = pkg(6360, 1);
    for (const k of ['dtm', 'dsm']) {
      const bytes = p.get(`terrain-${k}.tif`);
      expect(geoKeys(bytes).keys.has(4096)).toBe(false);
      expect(gdalMetadata(bytes)).toContain('>metre</Item>');
    }
    expect(p.readme).toMatch(/Vertical CRS\s+not written/);
    expect(p.readme).toContain('EPSG:6360');
  });

  it('notes a vertical CRS left off because EPSG has none in the height unit', () => {
    const p = pkg(3855, 0.3048);
    expect(geoKeys(p.get('terrain-dtm.tif')).keys.has(4096)).toBe(false);
    expect(p.readme).toMatch(/Vertical CRS\s+not written/);
    expect(p.readme).toContain('EPSG:3855');
  });

  it('notes a depth CRS left off the height rasters', () => {
    const p = pkg(6357, 1);
    expect(geoKeys(p.get('terrain-dtm.tif')).keys.has(4096)).toBe(false);
    expect(p.readme).toMatch(/Vertical CRS\s+not written/);
    expect(p.readme).toMatch(/depth/);
  });

  it('states where the height unit of a written vertical CRS comes from', () => {
    const flat = pkg(5703, US_FT).readme.replace(/\s+/g, ' ');
    expect(flat).toContain('its horizontal unit when the source declares no vertical unit');
  });

  // None of these rasters carries a vertical key, so their bytes are pinned.
  it('leaves the CHM, evidence, sensitivity and attention rasters byte-identical', () => {
    const p = pkg(5703, 1);
    const digest = (name: string) => sha256Hex(p.get(name));
    expect({
      chm: digest('terrain-chm.tif'),
      evidence: digest('terrain_evidence.tif'),
      sensitivity: digest('terrain_sensitivity.tif'),
      attention: digest('terrain_attention.tif'),
    }).toEqual(PINNED);
  });
});

const PINNED = {
  chm: 'ba439ff08e6d999bbad53101f72ed1b05fc3c5d75b4fd5dde533c15837cb9bbf',
  evidence: '872b7475b84e89377c7e19e8302ae22e88ddab246526b7d69e147c4d4ce998a7',
  sensitivity: 'ddceaf811d6b1b3c9a8e22bcde14b2438b6e3a48fb1d796cbf47e7b89c1cd225',
  attention: 'e30701153d75554e59a2ae81998c64cf96295db41de0ff5d5f210b2b52c0ef05',
};

describe('a DTM with no vertical CRS but a known height unit', () => {
  // The DEM package and the contour deliverable write the same DTM, so they
  // must state its unit the same way.
  function dtmResult() {
    const g = grid();
    const result = demResultFor(g, 0.3048);
    (result.dtm as { verticalEpsg: number | null }).verticalEpsg = null;
    return result;
  }

  it('carries the unit as UNITTYPE in both products', () => {
    const fromPackage = extractEntry(buildDemPackage(dtmResult(), DEM_PKG_OPTS), 'terrain-dtm.tif')!;
    const fromDeliverable = extractEntry(buildContourDeliverableFromResult(dtmResult(), {
      decision: validatedDecision(DTM_CLAIMS),
      basename: 'site',
      worldOrigin: DEM_PKG_OPTS.worldOrigin,
      isGeographic: false,
      softwareVersion: '0.7.0',
      metricVersion: 'v0.4.1',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      exportPermit: null,
    }), 'site_DTM.tif')!;
    for (const bytes of [fromPackage, fromDeliverable]) {
      expect(geoKeys(bytes).keys.has(4096)).toBe(false);
      expect(gdalMetadata(bytes)).toContain('>foot</Item>');
    }
  });
});
