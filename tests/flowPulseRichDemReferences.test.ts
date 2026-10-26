/**
 * flowPulseRichDemReferences.test.ts: Flow Pulse against RichDEM's own test
 * expectations.
 *
 * Pre-registered in `validation/protocols/richdem-references-v1.md`. The six
 * files in `validation/field-simulation/richdem-references/` are RichDEM's,
 * kept byte for byte and read here as data with this file's own Esri ASCII
 * parser. RichDEM is not built or run.
 *
 * R1 to R3 compare with RichDEM's expected outputs. H1 and H2 are hand
 * derivations on two example grids RichDEM ships without expected outputs, and
 * say nothing about RichDEM.
 *
 * Text row 0 is the northern row. Flow Pulse's row 0 is the southern row, so
 * grids are reversed on load and RichDEM's y (down the text) is flipped when a
 * direction code becomes a receiver.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { CELL_FLAT, CELL_OUTLET, CELL_ROUTED, CELL_SINK, d8Flow, type D8Result } from '../src/simulation/flowPulse/d8Flow';
import { depressionInventory } from '../src/simulation/flowPulse/depressionInventory';
import { flowAccumulation } from '../src/simulation/flowPulse/flowAccumulation';
import { D8_NEIGHBOURS, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { filledCells, priorityFlood, type NoDataReading } from '../src/simulation/flowPulse/priorityFlood';
import { FLOW_PULSE_DEFAULTS } from '../src/simulation/flowPulse/flowPulseRunner';

const DIR = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation', 'richdem-references',
);

interface Asc { cols: number; rows: number; cellSize: number; noData: number; northFirst: number[][] }

/** Esri ASCII grid: six header lines, then rows north to south. */
function readAsc(path: string): Asc {
  const lines = readFileSync(join(DIR, path), 'utf8').split('\n').filter((l) => l.trim() !== '');
  const head: Record<string, number> = {};
  for (const l of lines.slice(0, 6)) {
    const [k, v] = l.trim().split(/\s+/);
    head[k.toLowerCase()] = Number(v);
  }
  const northFirst = lines.slice(6).map((l) => l.trim().split(/\s+/).map(Number));
  expect(northFirst).toHaveLength(head.nrows);
  for (const r of northFirst) expect(r).toHaveLength(head.ncols);
  return { cols: head.ncols, rows: head.nrows, cellSize: head.cellsize, noData: head.nodata_value, northFirst };
}

/** Values in Flow Pulse order (row 0 south). */
function southFirst(a: Asc): number[] {
  return [...a.northFirst].reverse().flat();
}

function gridOf(a: Asc): FlowGrid {
  const v = southFirst(a);
  const z = new Float32Array(v.length);
  const valid = new Uint8Array(v.length);
  v.forEach((x, i) => { if (x !== a.noData) { z[i] = x; valid[i] = 1; } });
  return { z, valid, cols: a.cols, rows: a.rows, cellMetresX: a.cellSize, cellMetresY: a.cellSize };
}

const MEASURED: Record<string, unknown> = {};
afterAll(() => {
  const path = process.env.RICHDEM_REPORT;
  if (path) writeFileSync(path, JSON.stringify(MEASURED, null, 1) + '\n');
});

describe('R1, R2: depression filling against RichDEM testdem1', () => {
  const dem = readAsc('tests/depressions/testdem1.dem');
  const want = southFirst(readAsc('tests/depressions/testdem1.all.out'));
  const grid = gridOf(dem);

  it.each(['wall', 'outlet'] as NoDataReading[])('R1 (NoData as %s): spill level equals the expected fill on every cell', (noData) => {
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData });
    const filled = filledCells(grid, cond);
    let mismatches = 0;
    let maskMismatches = 0;
    for (let i = 0; i < want.length; i++) {
      if (cond.spillLevel[i] !== want[i]) mismatches++;
      if ((filled[i] === 1) !== (want[i] > grid.z[i])) maskMismatches++;
    }
    MEASURED[`R1-${noData}`] = { cells: want.length, mismatches, maskMismatches, filledCells: filled.reduce((s, x) => s + x, 0) };
    expect(want).toHaveLength(100);
    expect(mismatches).toBe(0);
    expect(maskMismatches).toBe(0);
  });

  it('R2: the inventory lists the three depressions of the expected fill', () => {
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData: 'wall' });
    const inv = depressionInventory(grid, cond, filledCells(grid, cond), true);
    // Reference components of the cells the expected fill raises.
    const raised = want.map((w, i) => (w > grid.z[i] ? 1 : 0));
    const seen = new Uint8Array(raised.length);
    const ref: { seed: number; cells: number; maxDepth: number; levels: Set<number> }[] = [];
    for (let s = 0; s < raised.length; s++) {
      if (raised[s] !== 1 || seen[s] === 1) continue;
      const comp = { seed: s, cells: 0, maxDepth: 0, levels: new Set<number>() };
      const stack = [s];
      seen[s] = 1;
      while (stack.length > 0) {
        const i = stack.pop() as number;
        comp.cells++;
        comp.seed = Math.min(comp.seed, i);
        comp.maxDepth = Math.max(comp.maxDepth, want[i] - grid.z[i]);
        comp.levels.add(want[i]);
        const c = i % grid.cols;
        const r = (i - c) / grid.cols;
        for (const [dx, dy] of D8_NEIGHBOURS) {
          const nc = c + dx;
          const nr = r + dy;
          if (nc < 0 || nc >= grid.cols || nr < 0 || nr >= grid.rows) continue;
          const j = nr * grid.cols + nc;
          if (raised[j] === 1 && seen[j] === 0) { seen[j] = 1; stack.push(j); }
        }
      }
      ref.push(comp);
    }
    const bySeed = new Map(inv.depressions.map((d) => [d.seedCell, d]));
    const rows = ref.map((r) => {
      const d = bySeed.get(r.seed);
      return {
        seedCell: r.seed, refCells: r.cells, olvCells: d?.cells ?? null,
        areaM2: d?.areaM2 ?? null, refMaxDepth: r.maxDepth, olvMaxDepth: d?.maxFillDepth ?? null,
        refLevel: [...r.levels][0], refLevelCount: r.levels.size, olvOutlet: d?.outletElevation ?? null,
      };
    });
    MEASURED.R2 = { referenceDepressions: ref.length, olvDepressions: inv.depressions.length, rows };
    expect(ref).toHaveLength(3);
    expect(inv.depressions).toHaveLength(3);
    for (const r of rows) {
      expect(r.refLevelCount).toBe(1);
      expect(r.olvCells).toBe(r.refCells);
      expect(r.areaM2).toBe(r.refCells * 9);
      expect(r.olvMaxDepth).toBe(r.refMaxDepth);
      expect(r.olvOutlet).toBe(r.refLevel);
    }
  });
});

describe('R3: accumulation against RichDEM testdem1', () => {
  it('upstream counts over RichDEM directions equal the expected accumulation on every cell', () => {
    const d8 = readAsc('tests/flow_accum/testdem1.d8');
    const want = southFirst(readAsc('tests/flow_accum/testdem1.out'));
    // RichDEM D8: index k -> (d8x[k], d8y[k]) with y increasing down the text.
    const d8x = [0, -1, -1, 0, 1, 1, 1, 0, -1];
    const d8y = [0, 0, -1, -1, -1, 0, 1, 1, 1];
    const { cols, rows } = d8;
    const n = cols * rows;
    const receiver = new Int32Array(n).fill(-1);
    const status = new Uint8Array(n);
    let outlets = 0;
    for (let tr = 0; tr < rows; tr++) {
      for (let c = 0; c < cols; c++) {
        const k = d8.northFirst[tr][c];
        const here = (rows - 1 - tr) * cols + c;
        const nc = c + d8x[k];
        const ntr = tr + d8y[k];
        if (k === 0) { status[here] = CELL_SINK; continue; }
        if (nc < 0 || nc >= cols || ntr < 0 || ntr >= rows) { status[here] = CELL_OUTLET; outlets++; continue; }
        receiver[here] = (rows - 1 - ntr) * cols + nc;
        status[here] = CELL_ROUTED;
      }
    }
    const routed: D8Result = {
      receiver, status, direction: new Int8Array(n).fill(-1), sinkCount: 0, flatCount: 0, outletCount: outlets,
    };
    const grid: FlowGrid = {
      z: new Float32Array(n), valid: new Uint8Array(n).fill(1), cols, rows, cellMetresX: 3, cellMetresY: 3,
    };
    const acc = flowAccumulation(grid, routed);
    let mismatches = 0;
    for (let i = 0; i < n; i++) if (acc.upstreamCells[i] !== want[i]) mismatches++;
    MEASURED.R3 = { cells: n, mismatches, unresolvedCells: acc.unresolvedCells, outlets };
    expect(n).toBe(100);
    expect(mismatches).toBe(0);
    expect(acc.unresolvedCells).toBe(0);
  });
});

describe('hand-derived checks on RichDEM example grids (not a RichDEM comparison)', () => {
  it('H1 pit.dem: one depression of 8 cells raised by 1 to 6, area 72 m2, volume 72 m3', () => {
    const grid = gridOf(readAsc('data/pit.dem'));
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData: 'wall' });
    const inv = depressionInventory(grid, cond, filledCells(grid, cond), true);
    const got = inv.depressions.map((d) => ({ cells: d.cells, areaM2: d.areaM2, maxFillDepth: d.maxFillDepth, outletElevation: d.outletElevation }));
    const volume = cond.fillDepthSum * 9;
    MEASURED.H1 = { depressions: got, fillVolumeM3: volume, cellsRaised: cond.cellsRaised };
    expect(got).toEqual([{ cells: 8, areaM2: 72, maxFillDepth: 1, outletElevation: 6 }]);
    expect(volume).toBe(72);
  });

  it('H2 garbrecht.dem: raw D8 reports 22 flats; conditioned, every cell drains to the one lower edge cell', () => {
    const a = readAsc('data/garbrecht.dem');
    const grid = gridOf(a);
    const raw = d8Flow(grid);
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData: 'wall' });
    const routed = d8Flow({ ...grid, z: cond.z });
    const acc = flowAccumulation(grid, routed);
    // Row 6 from the north is Flow Pulse row 0; column 2.
    const outlet = 0 * a.cols + 2;
    let rawFlats = 0;
    for (const s of raw.status) if (s === CELL_FLAT) rawFlats++;
    MEASURED.H2 = {
      rawFlats: raw.flatCount, rawSinks: raw.sinkCount, conditionedFlats: routed.flatCount,
      conditionedSinks: routed.sinkCount, outletAccumulation: acc.upstreamCells[outlet], outletStatus: routed.status[outlet],
    };
    expect(raw.flatCount).toBe(22);
    expect(rawFlats).toBe(22);
    expect(raw.sinkCount).toBe(0);
    expect(routed.flatCount).toBe(0);
    expect(routed.sinkCount).toBe(0);
    expect(acc.upstreamCells[outlet]).toBe(49);
  });
});
