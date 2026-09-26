/**
 * Terrain sensitivity raster (terrain_sensitivity.tif): the fixed ensemble,
 * the per-cell bands, the DEM package entry and the terrain runs behind it.
 *
 * The oracle fixture under validation/terrain-sensitivity/ is rewritten by
 *   OLV_WRITE_SENSITIVITY_FIXTURE=1 npx vitest run tests/demSensitivity.test.ts
 * and checked independently by
 *   python3 validation/terrain-sensitivity/oracle/sensitivity_geotiff.py
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { extractEntry } from './helpers/zipReader';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import {
  SENSITIVITY_ENSEMBLE,
  TERRAIN_SENSITIVITY_BANDS,
  TERRAIN_SENSITIVITY_METHOD_ID,
  SensitivityGridMismatchError,
  runSensitivityEnsemble,
  sensitivityMemberParams,
  terrainSensitivityBands,
  writeTerrainSensitivityGeoTiff,
  type SensitivityMemberGrid,
} from '../src/terrain/export/demSensitivity';
import { computeTerrainCore, type AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { method as getMethod } from '../src/science/methodRegistry';
import { sha256Hex } from '../src/terrain/export/sha256';
import { verifyScientificArtifactPassport } from '../src/science/scientificArtifactPassport';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

// ── fixtures ────────────────────────────────────────────────────────────────

const COLS = 5;
const ROWS = 4;

/**
 * Four member grids on one 5 x 4 grid of 2 m cells. Heights are dyadic, so
 * every difference is exact in Float32. Cell 0 has no height in any member.
 * Member 1 lifts cells where (col + row) % 3 == 0 by 0.125; member 2 equals
 * member 0; member 3 lowers column 4 by 0.25 and has no height at cell 7.
 */
function memberGrids(): SensitivityMemberGrid[] {
  const n = COLS * ROWS;
  const make = (dz: (c: number, r: number, i: number) => number | null): SensitivityMemberGrid => {
    const z = new Float32Array(n);
    const coverage = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const c = i % COLS;
      const r = (i - c) / COLS;
      const d = i === 0 ? null : dz(c, r, i);
      if (d === null) { z[i] = Number.NaN; continue; }
      z[i] = 100 + 0.5 * c + 0.25 * r + d;
      coverage[i] = i === 6 ? 2 : 1;
    }
    return { z, coverage, cols: COLS, rows: ROWS, cellSizeM: 2, originH1: 10, originH2: 20 };
  };
  return [
    make(() => 0),
    make((c, r) => ((c + r) % 3 === 0 ? 0.125 : 0)),
    make(() => 0),
    make((c, _r, i) => (i === 7 ? null : c === 4 ? -0.25 : 0)),
  ];
}

const GOLDEN_RANGE = [
  null, 0, 0, 0.125, 0.25,
  0, 0, 0.125, 0, 0.25,
  0, 0.125, 0, 0, 0.375,
  0.125, 0, 0, 0.125, 0.25,
];
const GOLDEN_MEMBERS = [
  null, 4, 4, 4, 4,
  4, 4, 3, 4, 4,
  4, 4, 4, 4, 4,
  4, 4, 4, 4, 4,
];

function decodeFloatBands(bytes: Uint8Array): Float32Array[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = dv.getUint32(4, true);
  const count = dv.getUint16(start, true);
  const tags = new Map<number, number>();
  for (let k = 0; k < count; k++) {
    const p = start + 2 + k * 12;
    const type = dv.getUint16(p + 2, true);
    tags.set(dv.getUint16(p, true), type === 3 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true));
  }
  const cols = tags.get(256)!;
  const rows = tags.get(257)!;
  const spp = tags.get(277)!;
  let o = tags.get(273)!;
  const bands = Array.from({ length: spp }, () => new Float32Array(cols * rows));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let b = 0; b < spp; b++) {
        bands[b][(rows - 1 - r) * cols + c] = dv.getFloat32(o, true);
        o += 4;
      }
    }
  }
  return bands;
}

function resultFor(grid: SensitivityMemberGrid): AnalyseContoursResult {
  const n = grid.cols * grid.rows;
  const dtm = {
    ...grid,
    confidence: new Float32Array(n).fill(1),
    counts: new Uint32Array(n).map((_, i) => (grid.coverage[i] === 1 ? 3 : 0)),
    interpDistanceCells: new Float32Array(n).map((_, i) => (grid.coverage[i] === 2 ? 1 : 0)),
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: 5703, verticalUnitToMetres: 1,
    coverageMode: 'full', sourcePointCount: 100, analyzedPointCount: 100, warnings: [],
  } as unknown as DtmGrid;
  return {
    dtm,
    intervalM: 1,
    surface: { canopy: { heightM: new Float32Array(n).fill(Number.NaN) } },
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

// ── the ensemble ────────────────────────────────────────────────────────────

describe('sensitivity ensemble v1', () => {
  it('has exactly the four recorded members, canonical first', () => {
    expect(SENSITIVITY_ENSEMBLE).toEqual([
      { index: 0, label: 'canonical configuration' },
      { index: 1, label: 'ground filter slope 0.15', slope: 0.15 },
      { index: 2, label: 'ground filter slope 0.2', slope: 0.2 },
      { index: 3, label: 'inverse distance weighting void fill', interpolation: 'idw' },
    ]);
  });

  it('applies only the member override and keeps every other parameter', () => {
    const base = { cellSizeM: 1.5, ground: { maxWindowCells: 6, slope: 0.3 }, holdoutSeed: 7 };
    expect(sensitivityMemberParams(base, SENSITIVITY_ENSEMBLE[0])).toBe(base);
    expect(sensitivityMemberParams(base, SENSITIVITY_ENSEMBLE[1]))
      .toEqual({ cellSizeM: 1.5, ground: { maxWindowCells: 6, slope: 0.15 }, holdoutSeed: 7 });
    expect(sensitivityMemberParams({ cellSizeM: 1 }, SENSITIVITY_ENSEMBLE[2])).toEqual({ cellSizeM: 1, ground: { slope: 0.2 } });
    expect(sensitivityMemberParams(base, SENSITIVITY_ENSEMBLE[3])).toEqual({ ...base, interpolation: 'idw' });
    expect(base.ground.slope).toBe(0.3);
  });

  it('is a registered method', () => {
    expect(getMethod(TERRAIN_SENSITIVITY_METHOD_ID)?.version).toBe(1);
  });
});

// ── the bands ───────────────────────────────────────────────────────────────

describe('terrainSensitivityBands', () => {
  it('matches the golden range and member count cell by cell', () => {
    const b = terrainSensitivityBands(memberGrids());
    expect(Array.from(b.range, (v) => (Number.isNaN(v) ? null : v))).toEqual(GOLDEN_RANGE);
    expect(Array.from(b.members, (v, i) => (i === 0 ? null : v))).toEqual(GOLDEN_MEMBERS);
    expect(b.members[0]).toBe(0);
  });

  it('is 0 everywhere with the canonical grid alone', () => {
    const b = terrainSensitivityBands(memberGrids().slice(0, 1));
    for (let i = 1; i < b.range.length; i++) expect(b.range[i]).toBe(0);
  });

  it('refuses a member on a different grid, naming the member', () => {
    const g = memberGrids();
    g[2] = { ...g[2], originH1: 11 };
    expect(() => terrainSensitivityBands(g)).toThrow(SensitivityGridMismatchError);
    expect(() => terrainSensitivityBands(g)).toThrow(/member 2/);
    const h = memberGrids();
    h[3] = { ...h[3], cellSizeM: 1 };
    expect(() => terrainSensitivityBands(h)).toThrow(/member 3/);
  });
});

// ── the ensemble runner ─────────────────────────────────────────────────────

describe('runSensitivityEnsemble', () => {
  it('runs members 1 to 3 in order with their parameters and keeps member 0 as given', async () => {
    const seen: unknown[] = [];
    const grids = memberGrids();
    const out = await runSensitivityEnsemble(grids[0], { cellSizeM: 2 }, async (p) => {
      seen.push(p);
      return grids[seen.length];
    });
    expect(out[0]).toBe(grids[0]);
    expect(out).toHaveLength(4);
    expect(seen).toEqual([
      { cellSizeM: 2, ground: { slope: 0.15 } },
      { cellSizeM: 2, ground: { slope: 0.2 } },
      { cellSizeM: 2, interpolation: 'idw' },
    ]);
  });

  it('stops on a cancelled signal before any further run', async () => {
    const ac = new AbortController();
    let runs = 0;
    const grids = memberGrids();
    const p = runSensitivityEnsemble(grids[0], { cellSizeM: 2 }, async () => {
      runs++;
      ac.abort();
      return grids[1];
    }, ac.signal);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(runs).toBe(1);
  });

  it('refuses a mismatched member before returning', async () => {
    const grids = memberGrids();
    const bad = { ...grids[1], cols: 4, z: grids[1].z.slice(0, 16), coverage: grids[1].coverage.slice(0, 16) };
    await expect(runSensitivityEnsemble(grids[0], { cellSizeM: 2 }, async () => bad))
      .rejects.toThrow(SensitivityGridMismatchError);
  });

  it('runs the real terrain pipeline deterministically on one grid', async () => {
    // A 12 m x 12 m tilted plane with a 1 m step and a gap, 0.5 m point spacing.
    const pts: number[] = [];
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        if (x >= 9 && x <= 13 && y >= 9 && y <= 13) continue;
        pts.push(x * 0.5, y * 0.5, 50 + 0.1 * x * 0.5 + (x >= 16 ? 1 : 0));
      }
    }
    const positions = new Float32Array(pts);
    const params = { cellSizeM: 1 };
    const run = async (p: typeof params) => computeTerrainCore(positions, p).dtm;
    const canonical = await run(params);
    const a = await runSensitivityEnsemble(canonical, params, run);
    const b = await runSensitivityEnsemble(await run(params), params, run);
    expect(a.map((g) => sha256Hex(new Uint8Array(g.z.buffer)))).toEqual(b.map((g) => sha256Hex(new Uint8Array(g.z.buffer))));
    // The pipeline default slope is 0.2, so member 2 repeats member 0.
    expect(Array.from(a[2].z)).toEqual(Array.from(a[0].z));
    expect(computeTerrainCore(positions, { ...params, interpolation: 'idw' }).interpolation).toBe('idw');
    const bands = terrainSensitivityBands(a);
    for (let i = 0; i < bands.range.length; i++) {
      if (a[0].coverage[i] !== 0) expect(bands.range[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── the DEM package ─────────────────────────────────────────────────────────

describe('terrain_sensitivity.tif in the DEM package', () => {
  const grids = memberGrids();
  const off = buildDemPackage(resultFor(grids[0]), PKG_OPTS);
  const on = buildDemPackage(resultFor(grids[0]), { ...PKG_OPTS, sensitivityGrids: grids });
  const tif = extractEntry(on, 'terrain_sensitivity.tif')!;

  it('is off by default', () => {
    expect(extractEntry(off, 'terrain_sensitivity.tif')).toBeNull();
    expect(new TextDecoder().decode(extractEntry(off, 'terrain-README.txt')!)).not.toContain('sensitivity');
  });

  it('writes the golden bands with NoData where the DEM has none', () => {
    const [range, members] = decodeFloatBands(tif);
    expect(Array.from(range, (v) => (v === -9999 ? null : v))).toEqual(GOLDEN_RANGE);
    expect(Array.from(members, (v) => (v === -9999 ? null : v))).toEqual(GOLDEN_MEMBERS);
  });

  it('leaves every other file of the package unchanged apart from the README, passport and sums', () => {
    for (const name of ['terrain-dtm.tif', 'terrain-dsm.tif', 'terrain-chm.tif', 'terrain-dtm.asc', 'terrain_evidence.tif']) {
      expect(sha256Hex(extractEntry(on, name)!), name).toBe(sha256Hex(extractEntry(off, name)!));
    }
  });

  it('describes the ensemble in the README and lists the file', () => {
    const readme = new TextDecoder().decode(extractEntry(on, 'terrain-README.txt')!);
    expect(readme).toContain('terrain_sensitivity.tif');
    expect(readme).toContain('member 3  inverse distance weighting void fill');
    expect(readme).toContain('not that the height there is correct');
    const section = readme.slice(readme.indexOf('Terrain sensitivity ('), readme.indexOf(`Method ${TERRAIN_SENSITIVITY_METHOD_ID}`));
    expect(section).toContain('model sensitivity');
    expect(section).not.toMatch(/accura|uncertainty|confidence interval|\berror\b/i);
    expect(new TextDecoder().decode(extractEntry(on, 'SHA256SUMS.txt')!)).toContain('terrain_sensitivity.tif');
  });

  it('is bound into the DTM passport beside the evidence raster', () => {
    const passport = JSON.parse(new TextDecoder().decode(extractEntry(on, 'terrain-dtm.tif.olv-passport.json')!));
    const c = passport.companions.find((x: { filename: string }) => x.filename === 'terrain_sensitivity.tif');
    expect(c.method).toContain(TERRAIN_SENSITIVITY_METHOD_ID);
    expect(c.sha256).toBe(sha256Hex(tif));
    expect(verifyScientificArtifactPassport(passport, {
      artifactBytes: extractEntry(on, 'terrain-dtm.tif')!,
      companionBytes: {
        'terrain_evidence.tif': extractEntry(on, 'terrain_evidence.tif')!,
        'terrain_sensitivity.tif': tif,
      },
    })).toBe('VERIFIED');
  });

  it('is deterministic', () => {
    const again = buildDemPackage(resultFor(memberGrids()[0]), { ...PKG_OPTS, sensitivityGrids: memberGrids() });
    expect(sha256Hex(extractEntry(again, 'terrain_sensitivity.tif')!)).toBe(sha256Hex(tif));
  });
});

// ── independent-oracle fixture ──────────────────────────────────────────────

describe('terrain sensitivity oracle fixture', () => {
  const DIR = join(__dirname, '..', 'validation', 'terrain-sensitivity', 'fixture');
  const grids = memberGrids();
  const geo = {
    xllCorner: 600000 + grids[0].originH1, yllCorner: 4000000 + grids[0].originH2, noData: -9999,
    epsg: 32610, isGeographic: false, verticalUnit: 'm', demValues: grids[0].z,
  };
  const bytes = writeTerrainSensitivityGeoTiff(grids, geo);
  const b = terrainSensitivityBands(grids);
  const written = (i: number): boolean => grids[0].coverage[i] !== 0 && Number.isFinite(grids[0].z[i]);
  const expected = {
    note: 'TypeScript values for terrain_sensitivity.tif; grid order, row 0 = south. null = NoData or no height.',
    cols: COLS,
    rows: ROWS,
    cellSize: grids[0].cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: geo.noData,
    bandNames: [...TERRAIN_SENSITIVITY_BANDS],
    bandUnits: ['m', 'members'],
    members: SENSITIVITY_ENSEMBLE.map((m) => m.label),
    memberHeights: grids.map((g) => Array.from(g.z, (v, i) => (g.coverage[i] !== 0 && Number.isFinite(v) ? v : null))),
    sensitivityRange: Array.from(b.range, (v, i) => (written(i) ? v : null)),
    sensitivityMembers: Array.from(b.members, (v, i) => (written(i) ? v : null)),
    sha256: sha256Hex(bytes),
  };
  const json = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.OLV_WRITE_SENSITIVITY_FIXTURE === '1') {
    writeFileSync(join(DIR, 'terrain_sensitivity.tif'), bytes);
    writeFileSync(join(DIR, 'expected.json'), json);
  }

  it('the committed GeoTIFF and expectations match what the writer produces now', () => {
    expect(sha256Hex(new Uint8Array(readFileSync(join(DIR, 'terrain_sensitivity.tif'))))).toBe(sha256Hex(bytes));
    expect(readFileSync(join(DIR, 'expected.json'), 'utf8')).toBe(json);
  });
});
