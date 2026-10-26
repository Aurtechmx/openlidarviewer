/**
 * flowPulseExternalReferences.test.ts: Flow Pulse against TauDEM and GRASS on
 * real terrain.
 *
 * The study is pre-registered in
 * `validation/protocols/flow-pulse-external-references-v1.md`, which fixes the
 * parameters, the cell selections and the five gates this file evaluates. The
 * fixtures in `validation/field-simulation/external-references/` hold windows
 * of real terrain with the output of TauDEM 5.3.8 PitRemove (Bear Creek) and
 * GRASS GIS 8.3.2 (Riviere des Pluies, Reunion) for the same cells. Neither
 * tool was written in this project.
 *
 * Fixture rows run north to south, as in the source rasters. OpenLiDARViewer's
 * row 0 is the southern row and its D8 offsets take +drow as north, so every
 * grid and every reference index is flipped on load.
 *
 * Set FLOWREF_REPORT to a file path to write the measured values as JSON. The
 * values recorded with the result are in
 * `external-references/results/flow-pulse-external-references-v1.json`, and
 * the last case checks that the code still measures exactly those.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { depressionInventory } from '../src/simulation/flowPulse/depressionInventory';
import { edgeContamination } from '../src/simulation/flowPulse/edgeContamination';
import {
  FLOW_PULSE_DEFAULTS,
  catchmentFrom,
  runFlowPulse,
  type FlowPulseResult,
} from '../src/simulation/flowPulse/flowPulseRunner';
import { D8_NEIGHBOURS, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import {
  filledCells,
  priorityFlood,
  type NoDataReading,
} from '../src/simulation/flowPulse/priorityFlood';
import {
  FLOW_PROJECTED_SCALE,
  FLOW_TEST_IDENTITY,
  flowDtmOf,
} from './helpers/flowFixtures';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation',
  'external-references',
);

interface Fixture {
  readonly name: string;
  readonly cellMetresX: number;
  readonly cellMetresY: number;
  readonly z: readonly (readonly (number | null)[])[];
}

interface TauDemFixture extends Fixture {
  readonly reference: { readonly raised: readonly (readonly [number, number])[] };
}

interface GrassFixture extends Fixture {
  readonly reference: {
    readonly drainage: readonly number[];
    readonly accumulation: readonly number[];
    readonly catchmentMask: readonly number[];
    readonly mouthCell: readonly [number, number];
  };
}

const read = <T,>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;

/** The measured values as recorded with the result, relative to DIR. */
const RESULT = join('results', 'flow-pulse-external-references-v1.json');

/** Rows reversed so OpenLiDARViewer's row 0 is the southern row. */
function southFirst(f: Fixture): (number | null)[][] {
  return [...f.z].reverse().map((row) => [...row]);
}

/** Fixture row-major index (row 0 north) to OpenLiDARViewer index (row 0 south). */
function toOlv(i: number, rows: number, cols: number): number {
  const c = i % cols;
  const r = (i - c) / cols;
  return (rows - 1 - r) * cols + c;
}

function gridOf(f: Fixture): FlowGrid {
  const rowsIn = southFirst(f);
  const rows = rowsIn.length;
  const cols = rowsIn[0].length;
  const z = new Float32Array(cols * rows);
  const valid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = rowsIn[r][c];
      if (v === null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: f.cellMetresX, cellMetresY: f.cellMetresY };
}

/** Per-cell reference: TauDEM's filled elevation as Float32, in OpenLiDARViewer order. */
function tauDemFill(f: TauDemFixture, grid: FlowGrid): { fel: Float32Array; raised: Uint8Array } {
  const fel = Float32Array.from(grid.z);
  const raised = new Uint8Array(grid.z.length);
  for (const [i, v] of f.reference.raised) {
    const k = toOlv(i, grid.rows, grid.cols);
    fel[k] = Math.fround(v);
    raised[k] = 1;
  }
  return { fel, raised };
}

// ── G1 and G2: Bear Creek against TauDEM PitRemove ─────────────────────────

interface G1Run { crop: string; noData: NoDataReading; compared: number; mismatches: number; cellsUnreachable: number }

function g1(name: string, f: TauDemFixture, noData: NoDataReading): G1Run {
  const grid = gridOf(f);
  const { fel } = tauDemFill(f, grid);
  const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData });
  let compared = 0;
  let mismatches = 0;
  for (let k = 0; k < grid.z.length; k++) {
    if (grid.valid[k] !== 1) continue;
    compared++;
    if (Math.fround(cond.spillLevel[k]) !== fel[k]) mismatches++;
  }
  return { crop: name, noData, compared, mismatches, cellsUnreachable: cond.cellsUnreachable };
}

interface G2Crop {
  crop: string;
  referenceDepressions: number;
  olvDepressions: number;
  maskMismatches: number;
  matched: number;
  fieldMismatches: { cells: number; areaM2: number; maxFillDepth: number; spillLevel: number; unmatched: number };
  referenceMultiLevel: number;
}

function g2(name: string, f: TauDemFixture): G2Crop {
  const grid = gridOf(f);
  const { fel, raised } = tauDemFill(f, grid);
  const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData: 'outlet' });
  const filled = filledCells(grid, cond);
  const inv = depressionInventory(grid, cond, filled, true);

  let maskMismatches = 0;
  for (let k = 0; k < raised.length; k++) if (raised[k] !== filled[k]) maskMismatches++;

  // Reference depressions: 8-connected components of TauDEM's raised cells.
  const { cols, rows } = grid;
  const label = new Int32Array(raised.length).fill(-1);
  const comps: { seed: number; cells: number; maxDepth: number; levels: Set<number> }[] = [];
  for (let s = 0; s < raised.length; s++) {
    if (raised[s] !== 1 || label[s] !== -1) continue;
    const comp = { seed: s, cells: 0, maxDepth: 0, levels: new Set<number>() };
    label[s] = comps.length;
    const stack = [s];
    while (stack.length > 0) {
      const c = stack.pop() as number;
      comp.cells++;
      if (c < comp.seed) comp.seed = c;
      const depth = fel[c] - grid.z[c];
      if (depth > comp.maxDepth) comp.maxDepth = depth;
      comp.levels.add(fel[c]);
      const col = c % cols;
      const row = (c - col) / cols;
      for (const [dx, dy] of D8_NEIGHBOURS) {
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (raised[nb] === 1 && label[nb] === -1) { label[nb] = comps.length; stack.push(nb); }
      }
    }
    comps.push(comp);
  }

  const bySeed = new Map(inv.depressions.map((d) => [d.seedCell, d]));
  const cellArea = grid.cellMetresX * grid.cellMetresY;
  const mis = { cells: 0, areaM2: 0, maxFillDepth: 0, spillLevel: 0, unmatched: 0 };
  let matched = 0;
  let multi = 0;
  for (const comp of comps) {
    if (comp.levels.size !== 1) multi++;
    const level = [...comp.levels][0];
    const d = bySeed.get(comp.seed);
    if (!d) { mis.unmatched++; continue; }
    let ok = true;
    if (d.cells !== comp.cells) { mis.cells++; ok = false; }
    if (d.areaM2 !== comp.cells * cellArea) { mis.areaM2++; ok = false; }
    if (d.maxFillDepth !== comp.maxDepth) { mis.maxFillDepth++; ok = false; }
    if (d.outletElevation === null || Math.fround(d.outletElevation) !== level) { mis.spillLevel++; ok = false; }
    if (ok) matched++;
  }
  return {
    crop: name,
    referenceDepressions: comps.length,
    olvDepressions: inv.depressions.length,
    maskMismatches,
    matched,
    fieldMismatches: mis,
    referenceMultiLevel: multi,
  };
}

// ── G3, G4, G5: Riviere des Pluies against GRASS ───────────────────────────

/** OpenLiDARViewer direction index to the GRASS code: 0 (E) is 8, the rest keep their number. */
const grassCode = (d: number): number => (d === 0 ? 8 : d);

function run(f: GrassFixture, conditioning: 'raw' | 'priority-flood'): FlowPulseResult {
  const dtm = flowDtmOf(southFirst(f), { cellSizeM: f.cellMetresX });
  const r = runFlowPulse(dtm, FLOW_PROJECTED_SCALE, {
    ...FLOW_PULSE_DEFAULTS,
    conditioning,
    ...(conditioning === 'priority-flood' ? { fillNoData: 'outlet' as const } : {}),
  }, FLOW_TEST_IDENTITY);
  if (!r.ok) throw new Error(`runFlowPulse refused: ${r.code}`);
  return r;
}

/** Reference arrays re-indexed to OpenLiDARViewer order. */
function grassArrays(f: GrassFixture, rows: number, cols: number) {
  const n = rows * cols;
  const drainage = new Int32Array(n);
  const accumulation = new Float64Array(n);
  const catchment = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = toOlv(i, rows, cols);
    drainage[k] = f.reference.drainage[i];
    accumulation[k] = f.reference.accumulation[i];
    catchment[k] = f.reference.catchmentMask[i];
  }
  const [mr, mc] = f.reference.mouthCell;
  return { drainage, accumulation, catchment, mouth: (rows - 1 - mr) * cols + mc };
}

// ── evaluation ──────────────────────────────────────────────────────────────

const report: Record<string, unknown> = {};

describe('Flow Pulse against TauDEM and GRASS (pre-registered gates)', () => {
  let bcA: TauDemFixture;
  let bcB: TauDemFixture;
  let re: GrassFixture;
  let raw: FlowPulseResult;
  let cond: FlowPulseResult;
  let ref: ReturnType<typeof grassArrays>;

  beforeAll(() => {
    bcA = read<TauDemFixture>('bear-creek-taudem-fill-A.json');
    bcB = read<TauDemFixture>('bear-creek-taudem-fill-B.json');
    re = read<GrassFixture>('reunion-pluies-grass.json');
    raw = run(re, 'raw');
    cond = run(re, 'priority-flood');
    ref = grassArrays(re, raw.grid.rows, raw.grid.cols);
  });

  it('G1: the spill level equals TauDEM PitRemove on every valid cell', () => {
    const runs = [g1('A', bcA, 'outlet'), g1('B', bcB, 'outlet'), g1('B', bcB, 'wall')];
    const compared = runs.reduce((s, r) => s + r.compared, 0);
    const mismatches = runs.reduce((s, r) => s + r.mismatches, 0);
    report.G1 = { runs, compared, mismatches, pass: mismatches === 0 && compared >= 172702 };
    expect(compared).toBe(172702);
    expect(mismatches).toBe(0);
  });

  it('G2: the conditioned depression inventory matches TauDEM depression for depression', () => {
    const crops = [g2('A', bcA), g2('B', bcB)];
    const expectedCounts = { A: 62, B: 125 };
    const matched = crops.reduce((s, c) => s + c.matched, 0);
    const reference = crops.reduce((s, c) => s + c.referenceDepressions, 0);
    const pass = crops.every((c) => c.maskMismatches === 0
      && c.olvDepressions === expectedCounts[c.crop as 'A' | 'B']
      && c.referenceDepressions === expectedCounts[c.crop as 'A' | 'B']
      && c.matched === c.referenceDepressions);
    report.G2 = { crops, matched, reference, pass };
    for (const c of crops) {
      expect(c.referenceMultiLevel).toBe(0);
      expect(c.maskMismatches).toBe(0);
      expect(c.referenceDepressions).toBe(expectedCounts[c.crop as 'A' | 'B']);
      expect(c.olvDepressions).toBe(expectedCounts[c.crop as 'A' | 'B']);
      expect(c.matched).toBe(c.referenceDepressions);
    }
  });

  it('G3: raw D8 direction agrees with GRASS on at least 0.98 of uniquely steepest catchment cells', () => {
    const { z, valid, cols, rows, cellMetresX, cellMetresY } = raw.grid;
    const step = D8_NEIGHBOURS.map(([dx, dy]) => Math.hypot(dx * cellMetresX, dy * cellMetresY));
    let eligible = 0;
    let agree = 0;
    const confusion: Record<string, number> = {};
    for (let k = 0; k < z.length; k++) {
      if (ref.catchment[k] !== 1 || valid[k] !== 1) continue;
      const col = k % cols;
      const row = (k - col) / cols;
      let best = -Infinity;
      let second = -Infinity;
      for (let d = 0; d < D8_NEIGHBOURS.length; d++) {
        const [dx, dy] = D8_NEIGHBOURS[d];
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (valid[nb] !== 1) continue;
        const g = (z[k] - z[nb]) / step[d];
        if (g > best) { second = best; best = g; } else if (g > second) second = g;
      }
      if (!(best > 0 && best - second > 1e-9)) continue;
      eligible++;
      const d = raw.routed.direction[k];
      const mine = d >= 0 ? grassCode(d) : 0;
      const theirs = Math.abs(ref.drainage[k]);
      if (mine === theirs) agree++;
      else { const key = `${mine}->${theirs}`; confusion[key] = (confusion[key] ?? 0) + 1; }
    }
    const fraction = agree / eligible;
    report.G3 = { eligible, agree, fraction, disagreementsByOlvToGrass: confusion, pass: eligible >= 50000 && fraction >= 0.98 };
    expect(eligible).toBeGreaterThanOrEqual(50000);
    expect(fraction).toBeGreaterThanOrEqual(0.98);
  });

  it('G4: the conditioned catchment from the mouth cell has Jaccard index at least 0.99 with GRASS', () => {
    const mine = catchmentFrom(cond, ref.mouth);
    let both = 0;
    let either = 0;
    let onlyOlv = 0;
    let onlyGrass = 0;
    for (let k = 0; k < mine.length; k++) {
      const a = mine[k] === 1;
      const b = ref.catchment[k] === 1;
      if (a || b) either++;
      if (a && b) both++;
      else if (a) onlyOlv++;
      else if (b) onlyGrass++;
    }
    const jaccard = both / either;
    report.G4 = {
      mouthOlvIndex: ref.mouth, mouthStatus: cond.routed.status[ref.mouth],
      olvCells: both + onlyOlv, grassCells: both + onlyGrass, both, union: either, onlyOlv, onlyGrass,
      jaccard, pass: either >= 50000 && jaccard >= 0.99,
    };
    expect(either).toBeGreaterThanOrEqual(50000);
    expect(jaccard).toBeGreaterThanOrEqual(0.99);
  });

  it('G5: conditioned accumulation is within 5% of GRASS on at least 0.90 of catchment cells', () => {
    let cells = 0;
    let within = 0;
    let exact = 0;
    let maxRel = 0;
    for (let k = 0; k < ref.catchment.length; k++) {
      if (ref.catchment[k] !== 1) continue;
      cells++;
      const theirs = Math.abs(ref.accumulation[k]);
      const mine = cond.accumulation.upstreamCells[k];
      const rel = Math.abs(mine - theirs) / theirs;
      if (rel <= 0.05) within++;
      if (mine === theirs) exact++;
      if (rel > maxRel) maxRel = rel;
    }
    const fraction = within / cells;
    report.G5 = {
      cells, within, fraction, exact, exactFraction: exact / cells, maxRelativeDifference: maxRel,
      pass: cells >= 50000 && fraction >= 0.9,
    };
    expect(cells).toBeGreaterThanOrEqual(50000);
    expect(fraction).toBeGreaterThanOrEqual(0.9);
  });

  it('exploratory: edge contamination against negative GRASS accumulation (no gate)', () => {
    const ec = edgeContamination(cond.grid, cond.routed);
    const tally = (only: (k: number) => boolean) => {
      const t = { bothFlagged: 0, olvOnly: 0, grassOnly: 0, neither: 0 };
      for (let k = 0; k < ec.contaminated.length; k++) {
        if (cond.grid.valid[k] !== 1 || !only(k)) continue;
        const a = ec.contaminated[k] === 1;
        const b = ref.accumulation[k] < 0;
        if (a && b) t.bothFlagged++;
        else if (a) t.olvOnly++;
        else if (b) t.grassOnly++;
        else t.neither++;
      }
      return t;
    };
    report.exploratoryEdgeContamination = {
      inwardEdgeCells: ec.inwardEdgeCells,
      contaminatedCells: ec.contaminatedCells,
      validCells: tally(() => true),
      catchmentCells: tally((k) => ref.catchment[k] === 1),
    };
    expect(ec.contaminated.length).toBe(cond.grid.z.length);
    const path = process.env.FLOWREF_REPORT;
    if (path) writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  });

  it('measures exactly what the recorded result says', () => {
    // The study manifests cite this file by sha256 as the candidate output, so
    // a change in what the code measures has to show up here first.
    const recorded = read<Record<string, unknown>>(RESULT);
    expect(JSON.parse(JSON.stringify(report))).toEqual(recorded);
  });
});
