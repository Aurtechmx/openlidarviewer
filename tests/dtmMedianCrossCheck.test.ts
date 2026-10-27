/**
 * The live DTM's per-cell median (rasterizeDtm, aggregation 'median') against
 * R terra and SciPy on measured cells, per
 * validation/protocols/dtm-median-gridding-v1.md. Each reference is compared
 * separately; the two references are also compared with each other. Filled
 * (IDW) cells are out of scope: rasterizeDtm does not fill.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { LIVE_DTM_AGGREGATION } from '../src/terrain/ground/liveDtmConstants';

const FIX = 'validation/cross-implementation/pdal-pipeline/fixtures/';
const REF = 'validation/cross-implementation/dtm-median/';
const N = 50;
const TOL = 1e-6;
const MIN_CELLS = 15000;
const NAMES = [
  'pc-01-plane-buildings', 'pc-02-rolling-buildings', 'pc-03-ridge-buildings',
  'pc-04-plane-lowblunders', 'pc-05-plane-gap', 'pc-06-bare-plane',
  'pc-07-bare-rolling', 'pc-08-bare-ridge',
];

interface Pt { x: number; y: number; z: number }

function loadInput(name: string): Pt[] {
  const lines = readFileSync(FIX + name + '.csv', 'utf8').trim().split('\n').slice(1);
  const truth = readFileSync(FIX + name + '.truth', 'utf8').trim();
  expect(truth.length).toBe(lines.length);
  const pts: Pt[] = [];
  lines.forEach((l, i) => {
    if (truth[i] !== '1') return;
    const [x, y, z] = l.split(',').map(Number);
    pts.push({ x, y, z });
  });
  return pts;
}

/** Grid indexed [row * N + col], row 0 south; NaN = no data. */
function loadAsc(path: string): Float64Array {
  const rows = readFileSync(path, 'utf8').trim().split('\n').slice(6);
  expect(rows.length).toBe(N);
  const g = new Float64Array(N * N);
  rows.forEach((line, i) => {
    const r = N - 1 - i;
    const v = line.trim().split(/\s+/).map(Number);
    expect(v.length).toBe(N);
    v.forEach((val, c) => { g[r * N + c] = val === -9999 ? Number.NaN : val; });
  });
  return g;
}

/** Cells sharing an edge on which some input return lies exactly (protocol: terra leg only). */
function edgeCells(pts: Pt[]): Set<number> {
  const s = new Set<number>();
  const add = (r: number, c: number) => { if (r >= 0 && r < N && c >= 0 && c < N) s.add(r * N + c); };
  for (const p of pts) {
    const onX = Number.isInteger(p.x) && p.x > 0 && p.x < N;
    const onY = Number.isInteger(p.y) && p.y > 0 && p.y < N;
    if (!onX && !onY) continue;
    const cs = onX ? [p.x - 1, p.x] : [Math.min(Math.floor(p.x), N - 1)];
    const rs = onY ? [p.y - 1, p.y] : [Math.min(Math.floor(p.y), N - 1)];
    for (const r of rs) for (const c of cs) add(r, c);
  }
  return s;
}

interface Leg { cells: number; excluded: number; maskMismatch: number; outside: number; maxDiff: number; maxRaw: number }

function compare(a: ArrayLike<number>, ref: Float64Array, skip: Set<number>): Leg {
  const leg: Leg = { cells: 0, excluded: skip.size, maskMismatch: 0, outside: 0, maxDiff: 0, maxRaw: 0 };
  for (let c = 0; c < N * N; c++) {
    if (skip.has(c)) continue;
    const ha = !Number.isNaN(a[c]);
    const hb = !Number.isNaN(ref[c]);
    if (ha !== hb) { leg.maskMismatch++; continue; }
    if (!ha) continue;
    leg.cells++;
    const d = Math.abs(a[c] - Math.fround(ref[c]));
    const raw = Math.abs(a[c] - ref[c]);
    if (d > TOL) leg.outside++;
    leg.maxDiff = Math.max(leg.maxDiff, d);
    leg.maxRaw = Math.max(leg.maxRaw, raw);
  }
  return leg;
}

function sum(legs: Leg[]): Leg {
  return legs.reduce((t, l) => ({
    cells: t.cells + l.cells, excluded: t.excluded + l.excluded, maskMismatch: t.maskMismatch + l.maskMismatch,
    outside: t.outside + l.outside, maxDiff: Math.max(t.maxDiff, l.maxDiff), maxRaw: Math.max(t.maxRaw, l.maxRaw),
  }));
}

const legs = { scipy: [] as Leg[], terra: [] as Leg[], refs: [] as Leg[] };
for (const name of NAMES) {
  const pts = loadInput(name);
  const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), {
    aggregation: LIVE_DTM_AGGREGATION,
    grid: { originH1: 0, originH2: 0, cols: N, rows: N, cellSizeM: 1 },
  });
  const scipy = loadAsc(`${REF}scipy/${name}__median.asc`);
  const terra = loadAsc(`${REF}terra/${name}__median.asc`);
  const skip = edgeCells(pts);
  legs.scipy.push(compare(raster.z, scipy, new Set()));
  legs.terra.push(compare(raster.z, terra, skip));
  legs.refs.push(compare(Float64Array.from(scipy, (v) => Math.fround(v)), terra, skip));
}

describe('DTM median gridding on measured cells (protocol dtm-median-gridding-v1)', () => {
  it('the live DTM aggregation is the median', () => {
    expect(LIVE_DTM_AGGREGATION).toBe('median');
  });
  for (const key of ['scipy', 'terra', 'refs'] as const) {
    it(`${key === 'refs' ? 'SciPy against terra' : `OLV against ${key}`}: occupancy matches and every cell is within 1e-6 m`, () => {
      const t = sum(legs[key]);
      console.log(`[dtm-median] ${key}: cells=${t.cells} excluded=${t.excluded} maskMismatch=${t.maskMismatch} outside=${t.outside} maxDiff=${t.maxDiff} maxRaw=${t.maxRaw}`);
      expect(t.maskMismatch).toBe(0);
      expect(t.outside).toBe(0);
      expect(t.cells).toBeGreaterThanOrEqual(MIN_CELLS);
    });
  }
});

describe('export evidence note matches the median study scope', () => {
  it('names median gridding on measured cells and excludes filled cells', async () => {
    const { EVIDENCE_GATE_NOTE } = await import('../src/terrain/export/exportProvenance');
    expect(EVIDENCE_GATE_NOTE).not.toContain('min-return DTM gridding (this DTM uses median aggregation)');
    expect(EVIDENCE_GATE_NOTE).toContain('median gridding on measured cells');
    expect(EVIDENCE_GATE_NOTE).toContain('filled cells are not covered');
  });
});

// ── Protocol v2: other cell sizes, origin at the data minimum ─────────────────
// validation/protocols/dtm-median-gridding-v2.md. OLV's side gets only the cell
// size, so rasterizeDtm's own origin and extent logic builds the grid.

const SHIFT_X = 0.37;
const SHIFT_Y = 0.61;
export const V2_SETS = [
  { id: 'PS-DTM-MEDIAN-CELL0.25-ORIGINMIN', size: 0.25, dir: 'cell0.25', min: 35000 },
  { id: 'PS-DTM-MEDIAN-CELL0.5-ORIGINMIN', size: 0.5, dir: 'cell0.5', min: 25000 },
  { id: 'PS-DTM-MEDIAN-CELL2-ORIGINMIN', size: 2, dir: 'cell2', min: 2500 },
  { id: 'PS-DTM-MEDIAN-CELL5-ORIGINMIN', size: 5, dir: 'cell5', min: 400 },
] as const;

interface Asc { cols: number; rows: number; x0: number; y0: number; s: number; g: Float64Array }

function loadAscV2(path: string): Asc {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const h = Object.fromEntries(lines.slice(0, 6).map((l) => { const [k, v] = l.trim().split(/\s+/); return [k, Number(v)]; }));
  const cols = h.ncols, rows = h.nrows;
  const g = new Float64Array(cols * rows);
  const body = lines.slice(6);
  expect(body.length).toBe(rows);
  body.forEach((line, i) => {
    const r = rows - 1 - i;
    const v = line.trim().split(/\s+/).map(Number);
    expect(v.length).toBe(cols);
    v.forEach((val, c) => { g[r * cols + c] = val === -9999 ? Number.NaN : val; });
  });
  return { cols, rows, x0: h.xllcorner, y0: h.yllcorner, s: h.cellsize, g };
}

/** Cells sharing an interior edge on which a return lies within 1e-9 cell widths (v2: every leg). */
function edgeCellsV2(pts: Pt[], ox: number, oy: number, s: number, cols: number, rows: number): Set<number> {
  const out = new Set<number>();
  for (const p of pts) {
    const u = (p.x - ox) / s, v = (p.y - oy) / s;
    const ru = Math.round(u), rv = Math.round(v);
    const ex = Math.abs(u - ru) < 1e-9 && ru > 0 && ru < cols;
    const ey = Math.abs(v - rv) < 1e-9 && rv > 0 && rv < rows;
    if (!ex && !ey) continue;
    const cs = ex ? [ru - 1, ru] : [Math.min(Math.floor(u), cols - 1)];
    const rs = ey ? [rv - 1, rv] : [Math.min(Math.floor(v), rows - 1)];
    for (const r of rs) for (const c of cs) if (r >= 0 && r < rows && c >= 0 && c < cols) out.add(r * cols + c);
  }
  return out;
}

function compareV2(a: ArrayLike<number>, ref: Float64Array, skip: Set<number>): Leg {
  const leg: Leg = { cells: 0, excluded: skip.size, maskMismatch: 0, outside: 0, maxDiff: 0, maxRaw: 0 };
  for (let c = 0; c < ref.length; c++) {
    if (skip.has(c)) continue;
    const ha = !Number.isNaN(a[c]);
    const hb = !Number.isNaN(ref[c]);
    if (ha !== hb) { leg.maskMismatch++; continue; }
    if (!ha) continue;
    leg.cells++;
    const d = Math.abs(a[c] - Math.fround(ref[c]));
    if (d > TOL) leg.outside++;
    leg.maxDiff = Math.max(leg.maxDiff, d);
    leg.maxRaw = Math.max(leg.maxRaw, Math.abs(a[c] - ref[c]));
  }
  return leg;
}

describe('DTM median gridding at other cell sizes (protocol dtm-median-gridding-v2)', () => {
  for (const set of V2_SETS) {
    const v2 = { scipy: [] as Leg[], terra: [] as Leg[], refs: [] as Leg[] };
    let gridAgrees = true;
    for (const name of NAMES) {
      const pts = loadInput(name).map((p) => ({ x: p.x + SHIFT_X, y: p.y + SHIFT_Y, z: p.z }));
      const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), { aggregation: LIVE_DTM_AGGREGATION, cellSizeM: set.size });
      const scipy = loadAscV2(`${REF}scipy/${set.dir}/${name}__median.asc`);
      const terra = loadAscV2(`${REF}terra/${set.dir}/${name}__median.asc`);
      const gr = raster;
      for (const ref of [scipy, terra]) {
        if (ref.cols !== gr.cols || ref.rows !== gr.rows || ref.x0 !== gr.originH1 || ref.y0 !== gr.originH2) gridAgrees = false;
      }
      const skip = edgeCellsV2(pts, gr.originH1, gr.originH2, set.size, gr.cols, gr.rows);
      v2.scipy.push(compareV2(raster.z, scipy.g, skip));
      v2.terra.push(compareV2(raster.z, terra.g, skip));
      v2.refs.push(compareV2(Float64Array.from(scipy.g, (v) => Math.fround(v)), terra.g, skip));
    }
    it(`${set.id}: the references were given rasterizeDtm's own grid`, () => {
      expect(gridAgrees).toBe(true);
    });
    for (const key of ['scipy', 'terra', 'refs'] as const) {
      it(`${set.id} ${key === 'refs' ? 'SciPy against terra' : `OLV against ${key}`}: occupancy matches and every cell is within 1e-6 m`, () => {
        const t = sum(v2[key]);
        console.log(`[dtm-median-v2] ${set.id} ${key}: cells=${t.cells} excluded=${t.excluded} maskMismatch=${t.maskMismatch} outside=${t.outside} maxDiff=${t.maxDiff} maxRaw=${t.maxRaw}`);
        expect(t.maskMismatch).toBe(0);
        expect(t.outside).toBe(0);
        expect(t.cells).toBeGreaterThanOrEqual(set.min);
      });
    }
  }
});
