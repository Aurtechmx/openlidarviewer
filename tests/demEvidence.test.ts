/**
 * Terrain evidence raster (terrain_evidence.tif) and the multi-band GeoTIFF
 * writer behind it.
 *
 * The oracle fixture under validation/terrain-evidence/ is rewritten by
 *   OLV_WRITE_EVIDENCE_FIXTURE=1 npx vitest run tests/demEvidence.test.ts
 * and checked independently by
 *   python3 validation/terrain-evidence/oracle/evidence_geotiff.py
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DTM_CLAIMS, validatedDecision } from './helpers/exportDecisions';
import { extractEntry } from './helpers/zipReader';
import { writeGeoTiff, gdalMetadataXml } from '../src/terrain/export/demGeoTiff';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import {
  terrainEvidenceBands,
  writeTerrainEvidenceGeoTiff,
  squaredDistanceToSeeds,
  TERRAIN_EVIDENCE_BANDS,
  EVIDENCE_STATE_CODE,
  EVIDENCE_STATE_PARAMS,
} from '../src/terrain/export/demEvidence';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { computeCellMetrics } from '../src/terrain/quality/cellMetrics';
import { buildContourDeliverableFromResult } from '../src/terrain/export/contourDeliverableBuild';
import { buildDtmGrid, type DtmGrid } from '../src/terrain/ground/cellConfidence';
import { classifyCellStatus, CELL_STATUS_CODE } from '../src/terrain/quality/dtmCellStatus';
import { sha256Hex } from '../src/terrain/export/sha256';
import { verifyScientificArtifactPassport } from '../src/science/scientificArtifactPassport';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

// ── minimal TIFF reader ─────────────────────────────────────────────────────
interface Entry { type: number; count: number; at: number }
const TYPE_BYTES: Record<number, number> = { 2: 1, 3: 2, 4: 4, 12: 8 };

function ifd(bytes: Uint8Array): Map<number, Entry> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = dv.getUint32(4, true);
  const n = dv.getUint16(start, true);
  const out = new Map<number, Entry>();
  for (let k = 0; k < n; k++) {
    const p = start + 2 + k * 12;
    const type = dv.getUint16(p + 2, true);
    const count = dv.getUint32(p + 4, true);
    const size = (TYPE_BYTES[type] ?? 1) * count;
    out.set(dv.getUint16(p, true), { type, count, at: size <= 4 ? p + 8 : dv.getUint32(p + 8, true) });
  }
  return out;
}

function tagValues(bytes: Uint8Array, e: Entry): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let i = 0; i < e.count; i++) {
    if (e.type === 3) out.push(dv.getUint16(e.at + 2 * i, true));
    else if (e.type === 4) out.push(dv.getUint32(e.at + 4 * i, true));
    else if (e.type === 12) out.push(dv.getFloat64(e.at + 8 * i, true));
  }
  return out;
}

function tagText(bytes: Uint8Array, e: Entry): string {
  return new TextDecoder().decode(bytes.subarray(e.at, e.at + e.count - 1));
}

/** Decode a pixel-interleaved Float32 raster to per-band arrays in GRID order (row 0 = south). */
function decodeFloatBands(bytes: Uint8Array): { cols: number; rows: number; bands: Float32Array[] } {
  const t = ifd(bytes);
  const cols = tagValues(bytes, t.get(256)!)[0];
  const rows = tagValues(bytes, t.get(257)!)[0];
  const spp = tagValues(bytes, t.get(277)!)[0];
  const off = tagValues(bytes, t.get(273)!)[0];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bands = Array.from({ length: spp }, () => new Float32Array(cols * rows));
  let o = off;
  for (let r = 0; r < rows; r++) {
    const gridRow = rows - 1 - r;
    for (let c = 0; c < cols; c++) {
      for (let b = 0; b < spp; b++) {
        bands[b][gridRow * cols + c] = dv.getFloat32(o, true);
        o += 4;
      }
    }
  }
  return { cols, rows, bands };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Offsets (exact in binary) of the six returns in a full cell, scaled per cell. */
const RETURN_OFFSETS = [-0.375, -0.125, 0, 0.0625, 0.25, 0.5];

/**
 * Ground returns for a 12 x 10 grid of 2 m cells: measured everywhere except
 * an interior hole (filled, reaching edge risk inside it, with a centre too
 * far from data that the fill leaves empty), and a one-return column (low
 * confidence nearby, and no dispersion). Grid order, row 0 = south.
 */
function evidenceReturns(): { cols: number; rows: number; perCell: number[][] } {
  const cols = 12;
  const rows = 10;
  const perCell: number[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const hole = c >= 3 && c <= 10 && r >= 2 && r <= 8;
      const base = 100 + 0.5 * c + 0.25 * r;
      const scale = 1 + ((c + r) % 3);
      if (hole) perCell.push([]);
      else if (c === 0) perCell.push([base]);
      else perCell.push(RETURN_OFFSETS.map((o) => base + o * scale));
    }
  }
  return { cols, rows, perCell };
}

function evidenceGrid(): DtmGrid {
  const { cols, rows, perCell } = evidenceReturns();
  const points: Array<{ x: number; y: number; z: number }> = [];
  perCell.forEach((zs, i) => {
    const c = i % cols;
    const r = (i - c) / cols;
    for (const z of zs) points.push({ x: 10 + (c + 0.5) * 2, y: 20 + (r + 0.5) * 2, z });
  });
  const raster = rasterizeDtm(points, new Uint8Array(points.length).fill(1), {
    grid: { originH1: 10, originH2: 20, cols, rows, cellSizeM: 2 },
    aggregation: 'median',
  });
  return buildDtmGrid(
    raster,
    { crs: 'EPSG:32610', horizontalEpsg: 32610, verticalEpsg: 5703, verticalUnitToMetres: 1, maxInterpDistanceCells: 3 },
  );
}

/** Median absolute deviation, written out independently of the rasteriser. */
function mad(values: number[]): number {
  const med = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    const h = (s.length - 1) / 2;
    return s[Math.floor(h)] * 0.5 + s[Math.ceil(h)] * 0.5;
  };
  const m = med(values);
  return med(values.map((v) => Math.abs(v - m)));
}

function resultFor(grid: DtmGrid): AnalyseContoursResult {
  return {
    dtm: grid,
    intervalM: 1,
    surface: { canopy: { heightM: new Float32Array(grid.cols * grid.rows).fill(Number.NaN) } },
    accuracyStandards: {
      rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2,
      densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref',
    },
    quality: {
      readiness: 'ready', exportReadiness: 'available',
      crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: { measured: 0, interpolated: 0, lowConfidence: 0, edgeRisk: 0, empty: 0, total: 0 },
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}

const PKG_OPTS = {
  basename: 'terrain',
  worldOrigin: { x: 600000, y: 4000000 },
  generationDateIso: '2026-01-01T00:00:00.000Z',
} as const;

// ── writer ──────────────────────────────────────────────────────────────────

describe('writeGeoTiff single band', () => {
  // Digests of the writer's output before multi-band support existed.
  const values = new Float32Array([10, 20.5, 30.25, 40, -3.5, 7]);
  const coverage = new Uint8Array([2, 2, 1, 0, 1, 2]);
  const base = { values, coverage, cols: 3, rows: 2, cellSize: 0.5, xllCorner: 600000, yllCorner: 4000000 };

  it('writes the same bytes as before for Float32 and uint8 bands', () => {
    expect(sha256Hex(writeGeoTiff({ ...base, epsg: 32610, verticalEpsg: 5703, verticalUnitCode: 9001 })))
      .toBe('d8ecc0c43ee9f1364fbc296bb984ee99b250fc97e5c636977957fcbb433cd085');
    expect(sha256Hex(writeGeoTiff({
      ...base, values: coverage, coverage: new Uint8Array(6).fill(1), noData: 255, epsg: 32610, band: 'uint8',
    }))).toBe('ac3e839441feb0828ad3bf80da94d6e16d9a93846b16f24d80692b9ad752e814');
    expect(sha256Hex(writeGeoTiff({ ...base, epsg: 4326, isGeographic: true })))
      .toBe('f0d3ab8d70bbe9b937f5d3b1202b63b562b3789816bb2cc73608000d7b6d2011');
    expect(sha256Hex(writeGeoTiff({ ...base })))
      .toBe('8aa3beaa68fc85030baf27cafb8dffd66720280873f6d533804e70c2bf86747f');
  });

  it('writes a one-element bands list the same as the values form', () => {
    const a = writeGeoTiff({ ...base, epsg: 32610 });
    const b = writeGeoTiff({ ...base, values: undefined, bands: [{ values }], epsg: 32610 });
    expect(sha256Hex(b)).toBe(sha256Hex(a));
  });
});

describe('writeGeoTiff multi-band', () => {
  const cov = new Uint8Array([1, 1, 0, 1]);
  const geo = { coverage: cov, cols: 2, rows: 2, cellSize: 1, xllCorner: 0, yllCorner: 0, epsg: 32610 };

  it('writes per-band tags, ExtraSamples, GDAL_METADATA and interleaved samples', () => {
    const bytes = writeGeoTiff({
      ...geo,
      bands: [
        { values: [1, 2, 3, 4], description: 'a', unit: 'm' },
        { values: [5, 6, 7, 8], description: 'b<&>' },
        { values: [9, 10, 11, 12] },
      ],
    });
    const t = ifd(bytes);
    expect(tagValues(bytes, t.get(277)!)).toEqual([3]);
    expect(tagValues(bytes, t.get(258)!)).toEqual([32, 32, 32]);
    expect(tagValues(bytes, t.get(339)!)).toEqual([3, 3, 3]);
    expect(tagValues(bytes, t.get(338)!)).toEqual([0, 0]);
    expect(tagValues(bytes, t.get(284)!)).toEqual([1]);
    expect(tagValues(bytes, t.get(279)!)).toEqual([2 * 2 * 3 * 4]);
    const xml = tagText(bytes, t.get(42112)!);
    expect(xml).toContain('<Item name="DESCRIPTION" sample="0" role="description">a</Item>');
    expect(xml).toContain('<Item name="UNITTYPE" sample="0" role="unittype">m</Item>');
    expect(xml).toContain('sample="1" role="description">b&lt;&amp;&gt;</Item>');
    expect(tagText(bytes, t.get(42113)!)).toBe('-9999');
    const d = decodeFloatBands(bytes);
    expect(Array.from(d.bands[0])).toEqual([1, 2, -9999, 4]);
    expect(Array.from(d.bands[2])).toEqual([9, 10, -9999, 12]);
  });

  it('writes a two-band ExtraSamples inline and uint32 samples', () => {
    const bytes = writeGeoTiff({
      ...geo, noData: 0,
      bands: [{ values: [1, 2, 3, 70000], type: 'uint32' }, { values: [4, 5, 6, 7], type: 'uint32' }],
    });
    const t = ifd(bytes);
    expect(tagValues(bytes, t.get(258)!)).toEqual([32, 32]);
    expect(tagValues(bytes, t.get(339)!)).toEqual([1, 1]);
    expect(tagValues(bytes, t.get(338)!)).toEqual([0]);
    expect(t.has(42112)).toBe(false);
    const off = tagValues(bytes, t.get(273)!)[0];
    const dv = new DataView(bytes.buffer);
    // North row first: grid row 1 = cells 2 (no coverage), 3.
    expect([dv.getUint32(off, true), dv.getUint32(off + 4, true)]).toEqual([0, 0]);
    expect([dv.getUint32(off + 8, true), dv.getUint32(off + 12, true)]).toEqual([70000, 7]);
  });

  it('refuses bands of mixed sample types and short bands', () => {
    expect(() => writeGeoTiff({ ...geo, bands: [{ values: [1, 2, 3, 4] }, { values: [1, 2, 3, 4], type: 'uint8' }] }))
      .toThrow(/one sample type/);
    expect(() => writeGeoTiff({ ...geo, bands: [{ values: [1, 2, 3] }] })).toThrow(/rows\*cols/);
    expect(gdalMetadataXml([{ values: [] }])).toBeNull();
  });
});

// ── the evidence raster in the DEM package ──────────────────────────────────

describe('terrain_evidence.tif in the DEM package', () => {
  const grid = evidenceGrid();
  const zip = buildDemPackage(resultFor(grid), PKG_OPTS);
  const ev = extractEntry(zip, 'terrain_evidence.tif')!;
  const dtmTif = extractEntry(zip, 'terrain-dtm.tif')!;

  it('the fixture exercises every cell state, and edge affected', () => {
    const states = new Set(classifyCellStatus(grid));
    for (const code of Object.values(CELL_STATUS_CODE)) expect(states.has(code), `state ${code}`).toBe(true);
    const extended = new Set(terrainEvidenceBands(grid).cellState);
    for (const code of [1, 2, 3, 4, 5]) expect(extended.has(code), `extended state ${code}`).toBe(true);
  });

  it('is written with six Float32 bands named in GDAL_METADATA, ED-1 bands first', () => {
    expect(ev).not.toBeNull();
    const t = ifd(ev);
    expect(tagValues(ev, t.get(277)!)).toEqual([6]);
    expect(tagValues(ev, t.get(339)!)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(TERRAIN_EVIDENCE_BANDS.slice(0, 3)).toEqual(['support_count', 'interpolation_distance', 'cell_state']);
    const xml = tagText(ev, t.get(42112)!);
    TERRAIN_EVIDENCE_BANDS.forEach((name, i) => {
      expect(xml).toContain(`sample="${i}" role="description">${name}</Item>`);
    });
    expect(xml).toContain('sample="1" role="unittype">m</Item>');
    expect(xml).toContain('sample="4" role="unittype">m</Item>');
  });

  it('shares the DTM grid, origin, cell size, CRS and NoData mask', () => {
    const a = ifd(ev);
    const b = ifd(dtmTif);
    for (const tag of [256, 257, 33550, 33922, 42113]) {
      expect(tagValues(ev, a.get(tag)!).join() || tagText(ev, a.get(tag)!))
        .toBe(tagValues(dtmTif, b.get(tag)!).join() || tagText(dtmTif, b.get(tag)!));
    }
    // Horizontal CRS keys match; the evidence raster carries no vertical CRS.
    const keys = (bytes: Uint8Array, t: Map<number, Entry>): number[] => tagValues(bytes, t.get(34735)!);
    expect(keys(ev, a)).toContain(32610);
    expect(keys(ev, a)).not.toContain(5703);
    const dem = decodeFloatBands(dtmTif).bands[0];
    const bands = decodeFloatBands(ev).bands;
    for (let i = 0; i < dem.length; i++) {
      // Band 5 is also NoData on a covered cell with fewer than two returns.
      bands.forEach((band, b) => {
        if (b === 4) { if (dem[i] === -9999) expect(band[i], `cell ${i}`).toBe(-9999); }
        else expect(band[i] === -9999, `cell ${i} band ${b + 1}`).toBe(dem[i] === -9999);
      });
    }
  });

  it('band 1 is the ground-return count and band 3 the extended cell state code', () => {
    const [count, , state] = decodeFloatBands(ev).bands;
    const codes = classifyCellStatus(grid);
    const edge = decodeFloatBands(ev).bands[5];
    let affected = 0;
    for (let i = 0; i < grid.coverage.length; i++) {
      if (grid.coverage[i] === 0) continue;
      expect(count[i]).toBe(grid.counts[i]);
      const nearEdge = edge[i] <= EVIDENCE_STATE_PARAMS.edgeAffectedWithinCells * grid.cellSizeM;
      const interp = codes[i] === CELL_STATUS_CODE.interpolated || codes[i] === CELL_STATUS_CODE.lowConfidence;
      if (interp && nearEdge) {
        expect(state[i]).toBe(EVIDENCE_STATE_CODE.edgeAffected);
        affected++;
      } else {
        expect(state[i]).toBe(codes[i]);
      }
    }
    expect(affected).toBeGreaterThan(0);
  });

  it('band 4 is the straight-line distance to the nearest measured cell centre', () => {
    const near = decodeFloatBands(ev).bands[3];
    const { cols } = grid;
    const measured: number[] = [];
    grid.counts.forEach((k, i) => { if (k > 0) measured.push(i); });
    for (let i = 0; i < grid.coverage.length; i++) {
      if (grid.coverage[i] === 0) continue;
      let best = Infinity;
      for (const j of measured) {
        const dx = (i % cols) - (j % cols);
        const dy = Math.floor(i / cols) - Math.floor(j / cols);
        best = Math.min(best, dx * dx + dy * dy);
      }
      expect(near[i]).toBe(Math.fround(Math.sqrt(best) * grid.cellSizeM));
    }
  });

  it('the distance transform matches brute force on a scattered grid', () => {
    const cols = 23;
    const rows = 17;
    const seed = new Uint8Array(cols * rows);
    let x = 12345;
    for (let i = 0; i < seed.length; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      seed[i] = x % 11 === 0 ? 1 : 0;
    }
    const d2 = squaredDistanceToSeeds(seed, cols, rows);
    for (let i = 0; i < seed.length; i++) {
      let best = Infinity;
      for (let j = 0; j < seed.length; j++) {
        if (!seed[j]) continue;
        const dx = (i % cols) - (j % cols);
        const dy = Math.floor(i / cols) - Math.floor(j / cols);
        best = Math.min(best, dx * dx + dy * dy);
      }
      expect(d2[i]).toBe(best);
    }
    expect(Array.from(squaredDistanceToSeeds(new Uint8Array(6), 3, 2))).toEqual(new Array(6).fill(Infinity));
  });

  it('band 5 is the median absolute deviation of the returns, NoData under two', () => {
    const disp = decodeFloatBands(ev).bands[4];
    const { perCell } = evidenceReturns();
    let written = 0;
    for (let i = 0; i < grid.coverage.length; i++) {
      if (grid.coverage[i] === 0) continue;
      if (perCell[i].length < 2) expect(disp[i]).toBe(-9999);
      else {
        expect(disp[i]).toBe(Math.fround(mad(perCell[i])));
        written++;
      }
    }
    expect(written).toBeGreaterThan(0);
    expect(new Set(Array.from(disp).filter((v) => v !== -9999)).size).toBeGreaterThan(1);
  });

  it('band 5 is NoData everywhere when the aggregation kept no returns', () => {
    const bare = { ...grid, verticalDispersion: undefined } as DtmGrid;
    expect(Array.from(terrainEvidenceBands(bare).verticalDispersion).every(Number.isNaN)).toBe(true);
  });

  it('band 6 uses the boundary-share boundary', () => {
    const edge = decodeFloatBands(ev).bands[5];
    const metrics = computeCellMetrics(grid).metrics;
    for (let i = 0; i < grid.coverage.length; i++) {
      if (grid.coverage[i] !== 2) continue;
      expect(edge[i]).toBe(Math.fround(metrics.edgeDistanceCells[i] * grid.cellSizeM));
    }
  });

  it('marks every covered cell unresolved when the vertical unit is unresolved', () => {
    const r = { ...resultFor(grid), verticalScaleResolved: false } as AnalyseContoursResult;
    const z = buildDemPackage(r, PKG_OPTS);
    const bands = decodeFloatBands(extractEntry(z, 'terrain_evidence.tif')!).bands;
    for (let i = 0; i < grid.coverage.length; i++) {
      expect(bands[2][i]).toBe(grid.coverage[i] === 0 ? -9999 : EVIDENCE_STATE_CODE.unresolved);
    }
    const t = ifd(extractEntry(z, 'terrain_evidence.tif')!);
    expect(tagText(extractEntry(z, 'terrain_evidence.tif')!, t.get(42112)!))
      .toContain('sample="4" role="unittype">unknown</Item>');
    expect(new TextDecoder().decode(extractEntry(z, 'terrain-README.txt')!)).toContain('has cell_state 6');
    // Bands other than cell_state do not depend on the frame.
    for (const b of [0, 1, 3, 4, 5]) expect(Array.from(bands[b])).toEqual(Array.from(decodeFloatBands(ev).bands[b]));
  });

  it('leaves the DEM rasters byte-identical to a package built without the evidence arrays', () => {
    const bare = { ...grid, counts: undefined, interpDistanceCells: undefined } as unknown as DtmGrid;
    const z = buildDemPackage(resultFor(bare), PKG_OPTS);
    for (const key of ['dtm', 'dsm', 'chm']) {
      for (const ext of ['tif', 'asc']) {
        const name = `terrain-${key}.${ext}`;
        expect(sha256Hex(extractEntry(z, name)!), name).toBe(sha256Hex(extractEntry(zip, name)!));
      }
    }
  });

  it('adds no dispersion under mean aggregation and leaves the raster otherwise unchanged', () => {
    const pts = [{ x: 0.5, y: 0.5, z: 1 }, { x: 0.5, y: 0.5, z: 3 }, { x: 1.5, y: 0.5, z: 2 }];
    const spec = { grid: { originH1: 0, originH2: 0, cols: 2, rows: 1, cellSizeM: 1 } };
    const mean = rasterizeDtm(pts, [1, 1, 1], spec);
    expect(mean.dispersion).toBeUndefined();
    const med = rasterizeDtm(pts, [1, 1, 1], { ...spec, aggregation: 'median' });
    expect(Array.from(med.z)).toEqual([2, 2]);
    expect(Array.from(med.dispersion!)).toEqual([1, Number.NaN]);
  });

  it('band 2 equals interpDistanceCells x cell size exactly', () => {
    const dist = decodeFloatBands(ev).bands[1];
    const bands = terrainEvidenceBands(grid);
    let interpolated = 0;
    for (let i = 0; i < grid.coverage.length; i++) {
      if (grid.coverage[i] === 0) continue;
      expect(dist[i]).toBe(Math.fround(grid.interpDistanceCells[i] * grid.cellSizeM));
      expect(dist[i]).toBe(bands.interpolationDistance[i]);
      if (grid.coverage[i] === 1) {
        interpolated++;
        expect(dist[i]).toBeGreaterThan(0);
      } else {
        expect(dist[i]).toBe(0);
      }
    }
    expect(interpolated).toBeGreaterThan(0);
  });

  it('cell_state agrees with Support.tif from the Contour Studio deliverable cell for cell', () => {
    const deliverable = buildContourDeliverableFromResult(resultFor(grid), {
      decision: validatedDecision(DTM_CLAIMS),
      basename: 'site',
      worldOrigin: PKG_OPTS.worldOrigin,
      isGeographic: false,
      softwareVersion: '0.7.0',
      metricVersion: 'v0.4.1',
      generatedAt: new Date('2026-01-01T00:00:00.000Z'),
      exportPermit: null,
    });
    const support = extractEntry(deliverable, 'site_Support.tif')!;
    const st = ifd(support);
    const off = tagValues(support, st.get(273)!)[0];
    const { cols, rows } = grid;
    const state = decodeFloatBands(ev).bands[2];
    let checked = 0;
    for (let r = 0; r < rows; r++) {
      const gridRow = rows - 1 - r;
      for (let c = 0; c < cols; c++) {
        const i = gridRow * cols + c;
        const s = support[off + r * cols + c];
        // Support.tif: 0 unsupported, 1 interpolated, 2 measured.
        if (s === 0) expect(state[i]).toBe(-9999);
        else if (s === 2) expect(state[i]).toBe(CELL_STATUS_CODE.measured);
        else expect([CELL_STATUS_CODE.interpolated, CELL_STATUS_CODE.lowConfidence, CELL_STATUS_CODE.edgeRisk,
          EVIDENCE_STATE_CODE.edgeAffected]).toContain(state[i]);
        checked++;
      }
    }
    expect(checked).toBe(cols * rows);
  });

  it('is listed in SHA256SUMS and the README, and bound in the DTM passport', () => {
    const sums = new TextDecoder().decode(extractEntry(zip, 'SHA256SUMS.txt')!);
    expect(sums).toContain(`${sha256Hex(ev)}  terrain_evidence.tif`);
    const readme = new TextDecoder().decode(extractEntry(zip, 'terrain-README.txt')!);
    expect(readme).toContain('terrain_evidence.tif');
    expect(readme).toContain('Band 2 interpolation_distance');
    expect(readme).toContain('do not describe how accurate a height is');
    const passport = JSON.parse(new TextDecoder().decode(extractEntry(zip, 'terrain-dtm.tif.olv-passport.json')!));
    expect(passport.companions[0]).toEqual(
      {
        filename: 'terrain_evidence.tif',
        mediaType: 'image/tiff',
        bytes: ev.length,
        sha256: sha256Hex(ev),
        method: 'olv.terrain.evidence.support@2',
      },
    );
    const attention = extractEntry(zip, 'terrain_attention.tif')!;
    expect(passport.companions.map((c: { filename: string }) => c.filename))
      .toEqual(['terrain_evidence.tif', 'terrain_attention.tif']);
    expect(verifyScientificArtifactPassport(passport, {
      artifactBytes: dtmTif, companionBytes: { 'terrain_evidence.tif': ev, 'terrain_attention.tif': attention },
    })).toBe('VERIFIED');
    const tampered = ev.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(verifyScientificArtifactPassport(passport, {
      companionBytes: { 'terrain_evidence.tif': tampered, 'terrain_attention.tif': attention },
    }))
      .toBe('ARTIFACT_CHANGED');
    expect(verifyScientificArtifactPassport(passport, { companionBytes: {} })).toBe('ARTIFACT_CHANGED');
  });

  it('is deterministic', () => {
    const again = extractEntry(buildDemPackage(resultFor(evidenceGrid()), PKG_OPTS), 'terrain_evidence.tif')!;
    expect(sha256Hex(again)).toBe(sha256Hex(ev));
  });

  it('is omitted, with no README entry, when the grid carries no per-cell support arrays', () => {
    const bare = { ...grid, counts: undefined, interpDistanceCells: undefined } as unknown as DtmGrid;
    const z = buildDemPackage(resultFor(bare), PKG_OPTS);
    expect(extractEntry(z, 'terrain_evidence.tif')).toBeNull();
    expect(new TextDecoder().decode(extractEntry(z, 'terrain-README.txt')!)).not.toContain('evidence.tif');
  });
});

// ── independent-oracle fixture ──────────────────────────────────────────────

describe('terrain evidence oracle fixture', () => {
  const DIR = join(__dirname, '..', 'validation', 'terrain-evidence', 'fixture');
  const grid = evidenceGrid();
  const geo = {
    xllCorner: 600000 + grid.originH1, yllCorner: 4000000 + grid.originH2, noData: -9999,
    epsg: 32610, isGeographic: false, horizontalUnit: 'm', verticalUnit: 'm', demValues: grid.z,
  };
  const bytes = writeTerrainEvidenceGeoTiff(grid, geo);
  const b = terrainEvidenceBands(grid);
  const cell = (i: number): number | null => (grid.coverage[i] !== 0 && Number.isFinite(grid.z[i]) ? 1 : null);
  const expected = {
    note: 'TypeScript values for terrain_evidence.tif; grid order, row 0 = south. null = NoData.',
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: geo.noData,
    bandNames: [...TERRAIN_EVIDENCE_BANDS],
    bandUnits: ['returns', 'm', 'code', 'm', 'm', 'm'],
    frameResolved: true,
    edgeAffectedWithinCells: EVIDENCE_STATE_PARAMS.edgeAffectedWithinCells,
    supportCount: Array.from(b.supportCount, (v, i) => (cell(i) ? v : null)),
    interpolationDistance: Array.from(b.interpolationDistance, (v, i) => (cell(i) ? v : null)),
    interpDistanceCells: Array.from(grid.interpDistanceCells, (v, i) => (cell(i) ? v : null)),
    cellState: Array.from(b.cellState, (v, i) => (cell(i) ? v : null)),
    nearestSupportDistance: Array.from(b.nearestSupportDistance, (v, i) => (cell(i) ? v : null)),
    verticalDispersion: Array.from(b.verticalDispersion, (v, i) => (cell(i) && Number.isFinite(v) ? v : null)),
    edgeDistance: Array.from(b.edgeDistance, (v, i) => (cell(i) && Number.isFinite(v) ? v : null)),
    returns: evidenceReturns().perCell,
    sha256: sha256Hex(bytes),
  };
  const json = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.OLV_WRITE_EVIDENCE_FIXTURE === '1') {
    writeFileSync(join(DIR, 'terrain_evidence.tif'), bytes);
    writeFileSync(join(DIR, 'expected.json'), json);
  }

  it('the committed GeoTIFF and expectations match what the writer produces now', () => {
    expect(sha256Hex(new Uint8Array(readFileSync(join(DIR, 'terrain_evidence.tif'))))).toBe(sha256Hex(bytes));
    expect(readFileSync(join(DIR, 'expected.json'), 'utf8')).toBe(json);
  });
});
