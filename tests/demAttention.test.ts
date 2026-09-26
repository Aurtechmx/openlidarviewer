/**
 * Terrain attention raster (terrain_attention.tif), the reconstruction
 * residual behind it, and the DEM evidence tier.
 *
 * The oracle fixture under validation/terrain-attention/ is rewritten by
 *   OLV_WRITE_ATTENTION_FIXTURE=1 npx vitest run tests/demAttention.test.ts
 * and checked independently by
 *   python3 validation/terrain-attention/oracle/attention_geotiff.py --check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { extractEntry } from './helpers/zipReader';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import {
  ATTENTION_PARAMS,
  ATTENTION_REASON_CODE as RC,
  ATTENTION_NO_DATA,
  TERRAIN_ATTENTION_BANDS,
  TERRAIN_ATTENTION_METHOD_ID,
  TERRAIN_RESIDUAL_METHOD_ID,
  attentionLevel,
  demEvidenceTier,
  membersDifferingFromCanonical,
  reconstructionResidual,
  rebuildHeldOutCell,
  residualStride,
  terrainAttentionBands,
  verticalReferenceInUnit,
  writeTerrainAttentionGeoTiff,
  type AttentionInputs,
} from '../src/terrain/export/demAttention';
import { EVIDENCE_STATE_CODE, terrainEvidenceBands } from '../src/terrain/export/demEvidence';
import type { SensitivityMemberGrid } from '../src/terrain/export/demSensitivity';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';
import { method as getMethod } from '../src/science/methodRegistry';
import { sha256Hex } from '../src/terrain/export/sha256';
import { verifyScientificArtifactPassport } from '../src/science/scientificArtifactPassport';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

// ── fixtures ────────────────────────────────────────────────────────────────

const COLS = 6;
const ROWS = 4;
const N = COLS * ROWS;

type HeightRule = (c: number, r: number) => number;

/** A fully measured grid with heights from `h`, 3 returns per cell, confidence 100. */
function grid(h: HeightRule, cols = COLS, rows = ROWS) {
  const n = cols * rows;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = h(i % cols, Math.floor(i / cols));
  return {
    z,
    counts: new Uint32Array(n).fill(3),
    coverage: new Uint8Array(n).fill(2),
    confidence: new Float32Array(n).fill(100),
    interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
  };
}

const flat: HeightRule = () => 100;
const step: HeightRule = (c) => (c < 3 ? 100 : 101);

function inputs(g: ReturnType<typeof grid>, over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    cols: g.cols, rows: g.rows, coverage: g.coverage, interpDistanceCells: g.interpDistanceCells,
    confidence: g.confidence, cellState: new Uint8Array(g.cols * g.rows).fill(1),
    residual: reconstructionResidual(g).residual, sensitivityRange: null,
    verticalReference: 0.3, frameResolved: true, ...over,
  };
}

/**
 * The oracle grid: a step between columns 2 and 3, one interpolated cell
 * (index 8) two cells from data, one low-confidence interpolated cell (index
 * 14), a thin measured cell (index 7), one isolated measured cell (index 23) whose neighbours are not
 * measured, and one cell (index 0) with no height.
 */
function oracleGrid() {
  const g = grid(step);
  const hole = (i: number, dist: number, conf: number): void => {
    g.counts[i] = 0; g.coverage[i] = 1; g.interpDistanceCells[i] = dist; g.confidence[i] = conf;
  };
  hole(8, 2, 60);
  hole(14, 1, 20);
  for (const i of [16, 17, 22]) hole(i, 1, 80);
  g.confidence[7] = 5; // a thin measured cell: low support
  g.counts[0] = 0; g.coverage[0] = 0; g.z[0] = Number.NaN; g.interpDistanceCells[0] = Infinity; g.confidence[0] = 0;
  return g;
}

function resultFor(g: ReturnType<typeof grid>, verticalUnitToMetres = 1): AnalyseContoursResult {
  const n = g.cols * g.rows;
  const dtm = {
    ...g,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: 5703, verticalUnitToMetres,
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

function decodeByteBands(bytes: Uint8Array): Uint8Array[] {
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
  const bands = Array.from({ length: spp }, () => new Uint8Array(cols * rows));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (let b = 0; b < spp; b++) bands[b][(rows - 1 - r) * cols + c] = bytes[o++];
    }
  }
  return bands;
}

function members(g: ReturnType<typeof grid>, lift: number): SensitivityMemberGrid[] {
  const moved = Float32Array.from(g.z, (v, i) => (i % COLS === 5 ? v + lift : v));
  const base = { coverage: g.coverage, cols: g.cols, rows: g.rows, cellSizeM: 1, originH1: 0, originH2: 0 };
  return [
    { ...base, z: g.z },
    { ...base, z: moved },
    { ...base, z: g.z },
    { ...base, z: g.z },
  ];
}

// ── pre-registered values ───────────────────────────────────────────────────

describe('pre-registered attention values', () => {
  it('match validation/protocols/evidencedem-attention-v1.md', () => {
    expect(ATTENTION_PARAMS.longInterpolationCells).toBe(3);
    expect(ATTENTION_PARAMS.lowSupportConfidence).toBe(33);
    expect(ATTENTION_PARAMS.verticalReferenceM).toBe(0.3);
    expect([...ATTENTION_PARAMS.levelCuts]).toEqual([0.33, 0.67, 1.0]);
    expect(ATTENTION_PARAMS.residualSampleLimit).toBe(250_000);
    const doc = readFileSync(join(__dirname, '..', 'validation', 'protocols', 'evidencedem-attention-v1.md'), 'utf8');
    for (const s of ['250,000', 'R = 0.30 m', 'below 0.33', '0.67 to below 1.0', '/ 3', '/ 33']) expect(doc).toContain(s);
  });

  it('bands scores at the cut-offs', () => {
    expect([0, 0.3299, 0.33, 0.6699, 0.67, 0.9999, 1].map(attentionLevel)).toEqual([0, 0, 1, 1, 2, 2, 3]);
  });

  it('expresses R in the file unit, and has none when the unit is unresolved', () => {
    expect(verticalReferenceInUnit(1)).toBe(0.3);
    expect(verticalReferenceInUnit(0.3048)).toBeCloseTo(0.984252, 6);
    expect(verticalReferenceInUnit(null)).toBeNull();
  });

  it('registers both methods', () => {
    expect(getMethod(TERRAIN_ATTENTION_METHOD_ID)?.id).toBe(TERRAIN_ATTENTION_METHOD_ID);
    expect(getMethod(TERRAIN_RESIDUAL_METHOD_ID)?.id).toBe(TERRAIN_RESIDUAL_METHOD_ID);
  });
});

// ── residual ────────────────────────────────────────────────────────────────

describe('reconstructionResidual', () => {
  it('is 0 on a flat plane', () => {
    const r = reconstructionResidual(grid(flat));
    expect(Array.from(r.residual)).toEqual(new Array(N).fill(0));
    expect(r).toMatchObject({ measuredCells: N, stride: 1, sampledCells: N, residualCells: N });
  });

  it('is high at a step and 0 away from it', () => {
    const r = reconstructionResidual(grid(step)).residual;
    for (let i = 0; i < N; i++) {
      const c = i % COLS;
      if (c === 2 || c === 3) expect(r[i], `cell ${i}`).toBeGreaterThan(0.2);
      else expect(r[i], `cell ${i}`).toBe(0);
    }
  });

  it('rebuilds only from measured 8-neighbours, NaN when there are none', () => {
    const g = oracleGrid();
    expect(rebuildHeldOutCell(g, 23)).toBeNaN();
    expect(reconstructionResidual(g).residual[23]).toBeNaN();
    // A far outlier two cells away does not move the rebuilt height.
    const far = grid(flat);
    far.z[5] = 500;
    expect(rebuildHeldOutCell(far, 7)).toBe(100);
  });

  it('samples every k-th measured cell in row order above the limit', () => {
    expect(residualStride(250_000)).toBe(1);
    expect(residualStride(250_001)).toBe(2);
    expect(residualStride(750_001)).toBe(4);
    const r = reconstructionResidual(grid(step), {}, 10);
    expect(r.stride).toBe(3);
    expect(r.sampledCells).toBe(8);
    for (let i = 0; i < N; i++) expect(Number.isNaN(r.residual[i]), `cell ${i}`).toBe(i % 3 !== 0);
  });
});

// ── attention ───────────────────────────────────────────────────────────────

describe('terrainAttentionBands', () => {
  it('is level 0 with no reason on a flat, fully measured plane', () => {
    const b = terrainAttentionBands(inputs(grid(flat)));
    expect(Array.from(b.level)).toEqual(new Array(N).fill(0));
    expect(Array.from(b.reason)).toEqual(new Array(N).fill(0));
  });

  it('flags the step with the residual as its reason', () => {
    const b = terrainAttentionBands(inputs(grid(step)));
    for (let i = 0; i < N; i++) {
      const c = i % COLS;
      if (c === 2 || c === 3) {
        expect(b.level[i], `cell ${i}`).toBeGreaterThan(0);
        expect(b.reason[i]).toBe(RC.RECONSTRUCTION_RESIDUAL);
      } else expect(b.level[i]).toBe(0);
    }
  });

  it('scores each input by its fixed rule', () => {
    const g = grid(flat);
    g.interpDistanceCells[0] = 1; // 1/3 -> level 1
    g.interpDistanceCells[1] = 2.1; // 0.7 -> level 2
    g.interpDistanceCells[2] = 5; // clipped 1 -> level 3
    g.confidence[3] = 10; // 1 - 10/33 = 0.697 -> level 2
    const state = new Uint8Array(N).fill(1);
    state[4] = EVIDENCE_STATE_CODE.edgeAffected;
    const sens = new Float32Array(N);
    sens[5] = 0.15; // 0.5 -> level 1
    const b = terrainAttentionBands(inputs(g, { cellState: state, sensitivityRange: sens }));
    expect(Array.from(b.level.slice(0, 6))).toEqual([1, 2, 3, 2, 3, 1]);
    expect(Array.from(b.reason.slice(0, 6))).toEqual([
      RC.LONG_INTERPOLATION, RC.LONG_INTERPOLATION, RC.LONG_INTERPOLATION,
      RC.LOW_SUPPORT, RC.EDGE_AFFECTED, RC.MODEL_SENSITIVITY,
    ]);
  });

  it('breaks a tie by vocabulary order', () => {
    const g = grid(flat);
    g.interpDistanceCells[0] = 3; // 1
    const state = new Uint8Array(N).fill(1);
    state[0] = EVIDENCE_STATE_CODE.edgeAffected; // 1
    const b = terrainAttentionBands(inputs(g, { cellState: state }));
    expect(b.reason[0]).toBe(RC.LONG_INTERPOLATION);
  });

  it('does not score the vertical inputs when the vertical unit is unresolved', () => {
    const b = terrainAttentionBands(inputs(grid(step), { verticalReference: null, frameResolved: false }));
    expect(Array.from(b.level)).toEqual(new Array(N).fill(0));
    expect(Array.from(b.reason)).toEqual(new Array(N).fill(RC.UNRESOLVED));
  });

  it('leaves a cell without a height at 0 and writes it as NoData', () => {
    const g = oracleGrid();
    const b = terrainAttentionBands(inputs(g));
    expect(b.level[0]).toBe(0);
    const tif = writeTerrainAttentionGeoTiff(b, g, { xllCorner: 0, yllCorner: 0, epsg: 32610, isGeographic: false, demValues: g.z });
    const [lv, rs] = decodeByteBands(tif);
    expect(lv[0]).toBe(ATTENTION_NO_DATA);
    expect(rs[0]).toBe(ATTENTION_NO_DATA);
  });
});

// ── tiers ───────────────────────────────────────────────────────────────────

describe('DEM evidence tier', () => {
  it('reflects only what the package contains', () => {
    const t = (passport: boolean, evidence: boolean, sensitivity: boolean, attention: boolean) =>
      demEvidenceTier({ passport, evidence, sensitivity, attention });
    expect(t(false, false, false, false)).toBe('T0');
    expect(t(true, false, false, false)).toBe('T1');
    expect(t(true, true, false, true)).toBe('T2');
    expect(t(true, true, true, false)).toBe('T2');
    expect(t(true, true, true, true)).toBe('T3');
  });

  it('counts ensemble members that differ from the canonical run', () => {
    const g = grid(flat);
    expect(membersDifferingFromCanonical(members(g, 0))).toBe(0);
    expect(membersDifferingFromCanonical(members(g, 0.5))).toBe(1);
  });
});

// ── package ─────────────────────────────────────────────────────────────────

describe('terrain_attention.tif in the DEM package', () => {
  const g = oracleGrid();
  const def = buildDemPackage(resultFor(g), PKG_OPTS);
  const withSens = buildDemPackage(resultFor(g), { ...PKG_OPTS, sensitivityGrids: members(g, 0.5) });
  const text = (zip: Uint8Array, name: string) => new TextDecoder().decode(extractEntry(zip, name)!);
  const passportOf = (zip: Uint8Array) => JSON.parse(text(zip, 'terrain-dtm.tif.olv-passport.json'));

  it('is written by default beside the evidence raster, and the package is T2', () => {
    expect(extractEntry(def, 'terrain_attention.tif')).not.toBeNull();
    const p = passportOf(def);
    expect(p.demEvidence.tier).toBe('T2');
    expect(p.demEvidence.sensitivity).toBeNull();
    expect(p.demEvidence.attention.residual).toMatchObject({ stride: 1, sampleLimit: 250_000 });
    expect(p.demEvidence.attention.verticalReference).toEqual({ metres: 0.3, inFileUnit: 0.3, unit: 'm' });
    expect(text(def, 'terrain-README.txt')).toContain('T2: evidence-mapped');
  });

  it('is T3 only with sensitivity, and states how many members differed', () => {
    const p = passportOf(withSens);
    expect(p.demEvidence.tier).toBe('T3');
    expect(p.demEvidence.sensitivity).toEqual({ members: 4, membersDifferingFromCanonical: 1 });
    const readme = text(withSens, 'terrain-README.txt');
    expect(readme).toContain('T3: internally examined');
    expect(readme).toContain('1 of 3 ensemble members');
  });

  it('adds MODEL_SENSITIVITY to the reasons only when sensitivity was requested', () => {
    const [, rDef] = decodeByteBands(extractEntry(def, 'terrain_attention.tif')!);
    const [, rSens] = decodeByteBands(extractEntry(withSens, 'terrain_attention.tif')!);
    expect(Array.from(rDef)).not.toContain(RC.MODEL_SENSITIVITY);
    expect(Array.from(rSens)).toContain(RC.MODEL_SENSITIVITY);
  });

  it('is bound into the DTM passport and verifies', () => {
    const p = passportOf(withSens);
    const names = p.companions.map((c: { filename: string }) => c.filename);
    expect(names).toEqual(['terrain_evidence.tif', 'terrain_sensitivity.tif', 'terrain_attention.tif']);
    const companionBytes = Object.fromEntries(names.map((n: string) => [n, extractEntry(withSens, n)!]));
    expect(verifyScientificArtifactPassport(p, { artifactBytes: extractEntry(withSens, 'terrain-dtm.tif')!, companionBytes }))
      .toBe('VERIFIED');
    expect(text(withSens, 'SHA256SUMS.txt')).toContain('terrain_attention.tif');
  });

  it('describes the rules in the README in plain terms', () => {
    const readme = text(def, 'terrain-README.txt');
    const section = readme.slice(readme.indexOf('Terrain attention ('), readme.indexOf('DEM evidence tier'));
    expect(section).toContain('evidencedem-attention-v1.md');
    expect(section).toContain('R is 0.3 m');
    expect(section).not.toMatch(/accura|uncertainty|confidence interval|\berror\b/i);
  });

  it('uses R in feet on a foot-vertical grid', () => {
    const p = passportOf(buildDemPackage(resultFor(g, 0.3048), { ...PKG_OPTS, verticalUnitToMetres: 0.3048 }));
    expect(p.demEvidence.attention.verticalReference.unit).toBe('ft');
    expect(p.demEvidence.attention.verticalReference.inFileUnit).toBeCloseTo(0.984252, 6);
  });

  it('is deterministic', () => {
    const again = buildDemPackage(resultFor(oracleGrid()), PKG_OPTS);
    expect(sha256Hex(extractEntry(again, 'terrain_attention.tif')!)).toBe(sha256Hex(extractEntry(def, 'terrain_attention.tif')!));
    expect(text(again, 'terrain-dtm.tif.olv-passport.json')).toBe(text(def, 'terrain-dtm.tif.olv-passport.json'));
  });
});

// ── independent-oracle fixture ──────────────────────────────────────────────

describe('terrain attention oracle fixture', () => {
  const DIR = join(__dirname, '..', 'validation', 'terrain-attention', 'fixture');
  const g = oracleGrid();
  const sens = new Float32Array(N);
  sens[11] = 0.25; // score 0.833, level 2
  sens[10] = 0.5; // clipped 1, level 3, unless the residual ties it first
  const ev = terrainEvidenceBands(g as unknown as DtmGrid);
  const res = reconstructionResidual(g);
  const inp = inputs(g, { cellState: ev.cellState, residual: res.residual, sensitivityRange: sens });
  const b = terrainAttentionBands(inp);
  const geo = { xllCorner: 600000, yllCorner: 4000000, epsg: 32610, isGeographic: false, demValues: g.z };
  const bytes = writeTerrainAttentionGeoTiff(b, g, geo);
  const written = (i: number): boolean => g.coverage[i] !== 0 && Number.isFinite(g.z[i]);
  const num = (v: number): number | null => (Number.isFinite(v) ? v : null);
  const expected = {
    note: 'TypeScript values for terrain_attention.tif; grid order, row 0 = south. null = NoData or no value.',
    cols: COLS,
    rows: ROWS,
    cellSize: g.cellSizeM,
    xllCorner: geo.xllCorner,
    yllCorner: geo.yllCorner,
    epsg: geo.epsg,
    noData: ATTENTION_NO_DATA,
    bandNames: [...TERRAIN_ATTENTION_BANDS],
    bandUnits: ['level', 'code'],
    params: {
      longInterpolationCells: ATTENTION_PARAMS.longInterpolationCells,
      lowSupportConfidence: ATTENTION_PARAMS.lowSupportConfidence,
      verticalReference: 0.3,
      levelCuts: [...ATTENTION_PARAMS.levelCuts],
      reasonOrder: Object.keys(RC).filter((k) => k !== 'NONE'),
      reasonCodes: RC,
      edgeAffectedState: EVIDENCE_STATE_CODE.edgeAffected,
      frameResolved: true,
    },
    heights: Array.from(g.z, (v) => num(v)),
    counts: Array.from(g.counts),
    coverage: Array.from(g.coverage),
    confidence: Array.from(g.confidence),
    interpDistanceCells: Array.from(g.interpDistanceCells, (v) => num(v)),
    cellState: Array.from(ev.cellState),
    sensitivityRange: Array.from(sens),
    residual: Array.from(res.residual, (v) => num(v)),
    attentionLevel: Array.from(b.level, (v, i) => (written(i) ? v : null)),
    dominantReason: Array.from(b.reason, (v, i) => (written(i) ? v : null)),
    sha256: sha256Hex(bytes),
  };
  const json = `${JSON.stringify(expected, null, 2)}\n`;
  if (process.env.OLV_WRITE_ATTENTION_FIXTURE === '1') {
    writeFileSync(join(DIR, 'terrain_attention.tif'), bytes);
    writeFileSync(join(DIR, 'expected.json'), json);
  }

  it('covers every reason the fixture can produce', () => {
    const reasons = new Set(b.reason);
    for (const code of [RC.LONG_INTERPOLATION, RC.LOW_SUPPORT, RC.EDGE_AFFECTED, RC.MODEL_SENSITIVITY, RC.RECONSTRUCTION_RESIDUAL]) {
      expect(reasons.has(code), `reason ${code}`).toBe(true);
    }
  });

  it('the committed GeoTIFF and expectations match what the writer produces now', () => {
    expect(sha256Hex(new Uint8Array(readFileSync(join(DIR, 'terrain_attention.tif'))))).toBe(sha256Hex(bytes));
    expect(readFileSync(join(DIR, 'expected.json'), 'utf8')).toBe(json);
  });
});
