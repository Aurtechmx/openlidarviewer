/**
 * demCodeTables.test.ts — every code the DEM package's code rasters carry is
 * explained in the package, by the same enum the writer stamps.
 *
 * The evidence, attention and sensitivity rasters write integer codes whose
 * meaning lived in README prose and nowhere a GIS could read. The package now
 * ships a QGIS layer style per code band and a README table per band, both
 * derived from EVIDENCE_STATE_CODE, ATTENTION_LEVEL_CODE, ATTENTION_REASON_CODE
 * and the ensemble size. These tests hold the derivation to the enums: a code
 * added to an enum has to appear in its style and its table.
 */
import { describe, it, expect } from 'vitest';
import { buildDemPackage } from '../src/terrain/export/demPackage';
import {
  evidenceCodeTable,
  attentionCodeTables,
  sensitivityMembersCodeTable,
  writePalettedQml,
  writePseudocolorQml,
  codeTablesReadmeLines,
} from '../src/terrain/export/demCodeTables';
import { EVIDENCE_STATE_CODE } from '../src/terrain/export/demEvidence';
import { ATTENTION_LEVEL_CODE, ATTENTION_REASON_CODE, ATTENTION_NO_DATA } from '../src/terrain/export/demAttention';
import { SENSITIVITY_ENSEMBLE, type SensitivityMemberGrid } from '../src/terrain/export/demSensitivity';
import { DEM_PKG_OPTS, demResultFor } from './helpers/demPackageFixture';
import { extractEntry, textOf } from './helpers/zipReader';

const COLS = 6;
const ROWS = 4;
const N = COLS * ROWS;

/** A measured grid with one interpolated cell and one empty cell, enough to write every raster. */
function grid() {
  const z = new Float32Array(N);
  for (let i = 0; i < N; i++) z[i] = 100 + (i % COLS) * 0.5;
  const g = {
    z,
    counts: new Uint32Array(N).fill(3),
    coverage: new Uint8Array(N).fill(2),
    confidence: new Float32Array(N).fill(100),
    interpDistanceCells: new Float32Array(N),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
  };
  g.counts[8] = 0; g.coverage[8] = 1; g.interpDistanceCells[8] = 2; g.confidence[8] = 60;
  g.counts[0] = 0; g.coverage[0] = 0; g.z[0] = Number.NaN; g.interpDistanceCells[0] = Infinity; g.confidence[0] = 0;
  return g;
}

function members(g: ReturnType<typeof grid>): SensitivityMemberGrid[] {
  const base = { coverage: g.coverage, cols: g.cols, rows: g.rows, cellSizeM: 1, originH1: 0, originH2: 0 };
  const moved = Float32Array.from(g.z, (v, i) => (i % COLS === 5 ? v + 0.5 : v));
  return [{ ...base, z: g.z }, { ...base, z: moved }, { ...base, z: g.z }, { ...base, z: g.z }];
}

const codesIn = (qml: string): number[] =>
  [...qml.matchAll(/paletteEntry value="(\d+)"/g)].map((m) => Number(m[1]));
const tableCodes = (lines: string[], bandName: string): number[] => {
  const start = lines.findIndex((l) => l.includes(` ${bandName} (style `));
  expect(start, `no README table for ${bandName}`).toBeGreaterThan(-1);
  const out: number[] = [];
  for (let i = start + 2; i < lines.length && /^\s{4}\s*\d+\s{2}/.test(lines[i]); i++) {
    out.push(Number(lines[i].trim().split(/\s+/)[0]));
  }
  return out;
};

describe('the code tables are the enums', () => {
  it('evidence cell_state: every EVIDENCE_STATE_CODE value, with its meaning', () => {
    const t = evidenceCodeTable();
    expect(t.entries.map((e) => e.code).sort((a, b) => a - b)).toEqual(Object.values(EVIDENCE_STATE_CODE).sort((a, b) => a - b));
    expect(t.entries.map((e) => e.key).sort()).toEqual(Object.keys(EVIDENCE_STATE_CODE).sort());
    for (const e of t.entries) expect(e.meaning.length).toBeGreaterThan(0);
  });

  it('attention level and reason: every ATTENTION_LEVEL_CODE and ATTENTION_REASON_CODE value', () => {
    const [level, reason] = attentionCodeTables();
    expect(level.entries.map((e) => e.code)).toEqual(Object.values(ATTENTION_LEVEL_CODE));
    expect(reason.entries.map((e) => e.code)).toEqual(Object.values(ATTENTION_REASON_CODE));
    expect(reason.entries.map((e) => e.key)).toEqual(Object.keys(ATTENTION_REASON_CODE));
  });

  it('sensitivity members: 0 to the ensemble size', () => {
    const t = sensitivityMembersCodeTable();
    expect(t.entries.map((e) => e.code)).toEqual(Array.from({ length: SENSITIVITY_ENSEMBLE.length + 1 }, (_, k) => k));
  });
});

describe('the QGIS styles and the README table carry every code', () => {
  const tables = [evidenceCodeTable(), ...attentionCodeTables(), sensitivityMembersCodeTable()];

  it('each paletted style lists every code of its table, on its band', () => {
    for (const t of tables) {
      const qml = writePalettedQml(t);
      expect(qml).toContain(`<rasterrenderer type="paletted" band="${t.band}"`);
      expect(codesIn(qml)).toEqual(t.entries.map((e) => e.code));
      for (const e of t.entries) expect(qml).toContain(`label="${e.code} `);
    }
  });

  it('the attention palettes leave out the NoData value and nothing else', () => {
    const [level] = attentionCodeTables();
    expect(codesIn(writePalettedQml(level, ATTENTION_NO_DATA))).toEqual(level.entries.map((e) => e.code));
    expect(codesIn(writePalettedQml(level, 0))).toEqual(level.entries.map((e) => e.code).filter((c) => c !== 0));
  });

  it('the pseudocolour style spans the range it was given', () => {
    const qml = writePseudocolorQml(1, 'sensitivity_range', 0, 0.5, 'm');
    expect(qml).toContain('classificationMin="0"');
    expect(qml).toContain('classificationMax="0.5"');
    expect(qml).toContain('singlebandpseudocolor');
  });

  it('the README table names every code of every table', () => {
    const lines = codeTablesReadmeLines(tables.map((t, i) => ({ table: t, rasterFile: `r${i}.tif`, styleFile: `s${i}.qml` })));
    for (const t of tables) expect(tableCodes(lines, t.bandName)).toEqual(t.entries.map((e) => e.code));
    expect(codeTablesReadmeLines([])).toEqual([]);
  });
});

describe('the package ships them', () => {
  const g = grid();
  const zip = buildDemPackage(demResultFor(g), { ...DEM_PKG_OPTS, sensitivityGrids: members(g), attention: true });
  const readme = textOf(zip, 'terrain-README.txt');
  const sums = textOf(zip, 'SHA256SUMS.txt');

  it('writes one style per code band and a ramp for the sensitivity range, all hashed', () => {
    for (const name of [
      'terrain_evidence.qml', 'terrain_attention.qml', 'terrain_attention-reason.qml',
      'terrain_sensitivity.qml', 'terrain_sensitivity-members.qml',
    ]) {
      const bytes = extractEntry(zip, name);
      expect(bytes, name).not.toBeNull();
      expect(new TextDecoder().decode(bytes!)).toContain('<qgis');
      expect(sums, `${name} is not in SHA256SUMS.txt`).toContain(name);
    }
  });

  it('the README code tables cover every raster band the package wrote', () => {
    const lines = readme.split('\n');
    expect(readme).toContain('Code tables');
    for (const t of [evidenceCodeTable(), ...attentionCodeTables(), sensitivityMembersCodeTable()]) {
      expect(tableCodes(lines, t.bandName)).toEqual(t.entries.map((e) => e.code));
    }
    expect(readme).toContain('terrain_evidence.qml');
    expect(readme).toContain('terrain_attention-reason.qml');
  });

  it('writes no style for a raster the package does not hold', () => {
    const plain = buildDemPackage(demResultFor(g), DEM_PKG_OPTS);
    expect(extractEntry(plain, 'terrain_sensitivity.qml')).toBeNull();
    expect(extractEntry(plain, 'terrain_attention.qml')).toBeNull();
    expect(textOf(plain, 'terrain-README.txt')).not.toContain('terrain_attention.qml');
  });
});
