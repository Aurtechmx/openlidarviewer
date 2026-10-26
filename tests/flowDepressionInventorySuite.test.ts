/**
 * flowDepressionInventorySuite.test.ts: the depression inventory across the
 * whole TF-1 to TF-8 fixture set and five constructed edge cases.
 *
 * Pre-registered in
 * `validation/protocols/depression-inventory-synthetic-suite-v1.md`. The
 * expected values were derived by hand for every grid except TF-8, and for
 * all of them computed by `validation/field-simulation/oracle/depression_oracle.py`,
 * a Python fill written from the definition and committed with its records in
 * `validation/field-simulation/expected-depressions/` before this file ran.
 * Both sides are this project's code, so agreement checks the arithmetic and
 * the bookkeeping, not the method against an outside tool.
 *
 * Grids are used as stored: the fill and the inventory do not depend on which
 * row is south, and every expected index is row-major over the stored grid.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { buildFlowPulsePackage } from '../src/export/flowPulsePackage';
import { depressionInventory } from '../src/simulation/flowPulse/depressionInventory';
import { FLOW_PULSE_DEFAULTS, runFlowPulse } from '../src/simulation/flowPulse/flowPulseRunner';
import { D8_NEIGHBOURS, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { filledCells, priorityFlood, type NoDataReading } from '../src/simulation/flowPulse/priorityFlood';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { textOf } from './helpers/zipReader';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation');

interface Grid { name: string; cellMetresX: number; cellMetresY: number; z: (number | null)[][] }
interface ExpectedDepression {
  seedCell: number; cells: number[]; cellCount: number; areaM2: number; maxFillDepth: number;
  fillDepthSum: number; fillVolumeM3: number; spillLevels: number[]; outletElevation: number | null;
}
interface ExpectedMode {
  cellsUnreachable: number; depressionCount: number; filledCellCount: number;
  fillDepthSum: number; fillVolumeM3: number; depressions: ExpectedDepression[];
}
interface Expected { wall: ExpectedMode; outlet: ExpectedMode }

const read = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

function gridOf(g: Grid): FlowGrid {
  const rows = g.z.length;
  const cols = g.z[0].length;
  const z = new Float32Array(rows * cols);
  const valid = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = g.z[r][c];
      if (v === null) continue;
      z[r * cols + c] = v;
      valid[r * cols + c] = 1;
    }
  }
  return { z, valid, cols, rows, cellMetresX: g.cellMetresX, cellMetresY: g.cellMetresY };
}

/** 8-connected components of a mask, as sorted member lists keyed by lowest member. */
function components(mask: Uint8Array, cols: number, rows: number): Map<number, number[]> {
  const seen = new Uint8Array(mask.length);
  const out = new Map<number, number[]>();
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] !== 1 || seen[s] === 1) continue;
    const members: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      members.push(i);
      const c = i % cols;
      const r = (i - c) / cols;
      for (const [dx, dy] of D8_NEIGHBOURS) {
        const nc = c + dx;
        const nr = r + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const j = nr * cols + nc;
        if (mask[j] === 1 && seen[j] === 0) { seen[j] = 1; stack.push(j); }
      }
    }
    members.sort((a, b) => a - b);
    out.set(members[0], members);
  }
  return out;
}

const SOURCES: [string, string][] = [
  ...readdirSync(join(ROOT, 'fixtures')).filter((f) => f.endsWith('.json')).sort().map((f): [string, string] => ['fixtures', f]),
  ...readdirSync(join(ROOT, 'depression-cases')).filter((f) => f.endsWith('.json')).sort().map((f): [string, string] => ['depression-cases', f]),
];

const MEASURED: Record<string, unknown> = {};

// Set DEPRESSION_SUITE_REPORT to a file path to write the measured values.
afterAll(() => {
  const path = process.env.DEPRESSION_SUITE_REPORT;
  if (path) writeFileSync(path, JSON.stringify(MEASURED, null, 1) + '\n');
});

describe('the grid set is complete', () => {
  it('has all eight TF fixtures and the five constructed cases', () => {
    expect(SOURCES.filter(([d]) => d === 'fixtures')).toHaveLength(8);
    expect(SOURCES.filter(([d]) => d === 'depression-cases')).toHaveLength(5);
  });
});

describe.each(SOURCES)('%s/%s', (dir, file) => {
  const g = read<Grid>(join(ROOT, dir, file));
  const want = read<Expected>(join(ROOT, 'expected-depressions', `${dir}__${file}`));
  const grid = gridOf(g);
  const cellArea = grid.cellMetresX * grid.cellMetresY;

  it.each(['wall', 'outlet'] as NoDataReading[])('NoData as %s: extents, counts, depths, volume, spill and outlet', (mode) => {
    const exp = want[mode];
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData: mode });
    const filled = filledCells(grid, cond);
    const inv = depressionInventory(grid, cond, filled, true);
    const comps = components(filled, grid.cols, grid.rows);
    const bySeed = new Map(inv.depressions.map((d) => [d.seedCell, d]));

    const got = {
      cellsUnreachable: cond.cellsUnreachable,
      depressionCount: inv.depressions.length,
      filledCellCount: inv.filledCellCount,
      cellsRaised: cond.cellsRaised,
      fillVolumeM3: cond.fillDepthSum * cellArea,
      depressions: exp.depressions.map((e) => {
        const d = bySeed.get(e.seedCell);
        const members = comps.get(e.seedCell) ?? [];
        const spill = members.map((i) => cond.spillLevel[i]);
        return {
          seedCell: e.seedCell,
          extentMatches: JSON.stringify(members) === JSON.stringify(e.cells),
          cellCount: d?.cells ?? null,
          areaM2: d?.areaM2 ?? null,
          maxFillDepth: d?.maxFillDepth ?? null,
          spillLevels: [...new Set(spill)].sort((a, b) => a - b),
          outletElevation: d?.outletElevation ?? null,
        };
      }),
    };
    MEASURED[`${dir}/${file}:${mode}`] = got;

    expect(got.cellsUnreachable).toBe(exp.cellsUnreachable);
    expect(got.depressionCount).toBe(exp.depressionCount);
    expect(got.filledCellCount).toBe(exp.filledCellCount);
    expect(got.cellsRaised).toBe(exp.filledCellCount);
    expect(got.fillVolumeM3).toBeCloseTo(exp.fillVolumeM3, 9);
    for (const [k, e] of exp.depressions.entries()) {
      const d = got.depressions[k];
      expect(d.extentMatches).toBe(true);
      expect(d.cellCount).toBe(e.cellCount);
      expect(d.areaM2).toBe(e.cellCount * cellArea);
      expect(d.maxFillDepth).toBe(e.maxFillDepth);
      expect(d.spillLevels).toEqual(e.spillLevels);
      expect(d.outletElevation).toBe(e.outletElevation);
    }
  });
});

describe('hand-derived values, stated here as well as in the oracle records', () => {
  const inv = (dir: string, file: string, noData: NoDataReading = 'wall') => {
    const grid = gridOf(read<Grid>(join(ROOT, dir, file)));
    const cond = priorityFlood(grid, { epsilon: FLOW_PULSE_DEFAULTS.fillEpsilon, noData });
    return { grid, cond, inv: depressionInventory(grid, cond, filledCells(grid, cond), true) };
  };

  it.each(['plane-east', 'ridge', 'anisotropic', 'valley-v', 'nodata-barrier', 'flat-plateau-outlet', 'boundary-opening'])(
    '%s has no depression', (name) => {
      const dir = name === 'boundary-opening' ? 'depression-cases' : 'fixtures';
      expect(inv(dir, `${name}.json`).inv.depressions).toHaveLength(0);
    },
  );

  it('TF-2 bowl: the pit fills to 4, one cell, depth 4, volume 4 m3, outlet 4', () => {
    const { inv: r, cond } = inv('fixtures', 'bowl-notched.json');
    expect(r.depressions.map((d) => [d.seedCell, d.cells, d.areaM2, d.maxFillDepth, d.outletElevation])).toEqual([[12, 1, 1, 4, 4]]);
    expect(cond.spillLevel[12]).toBe(4);
    expect(cond.fillDepthSum).toBe(4);
  });

  it('nested saddle: two pits and the saddle fill to the notch at 6 as one depression of 15 cells', () => {
    const { inv: r, cond } = inv('depression-cases', 'nested-saddle.json');
    expect(r.depressions.map((d) => [d.seedCell, d.cells, d.maxFillDepth, d.outletElevation])).toEqual([[8, 15, 5, 6]]);
    expect(cond.fillDepthSum).toBe(23);
  });

  it('diagonal contact: two corner-touching pits are one depression of two cells', () => {
    const { inv: r, cond } = inv('depression-cases', 'diagonal-contact.json');
    expect(r.depressions.map((d) => [d.seedCell, d.cells, d.maxFillDepth, d.outletElevation])).toEqual([[5, 2, 8, 9]]);
    expect(cond.fillDepthSum).toBe(16);
  });

  it('isolated NoData hole: a wall fills the ring around it to 9; an outlet fills nothing', () => {
    const wall = inv('depression-cases', 'nodata-hole.json', 'wall');
    expect(wall.inv.depressions.map((d) => [d.seedCell, d.cells, d.maxFillDepth, d.outletElevation])).toEqual([[6, 8, 6, 9]]);
    expect(wall.cond.fillDepthSum).toBe(34);
    expect(inv('depression-cases', 'nodata-hole.json', 'outlet').inv.depressions).toHaveLength(0);
  });

  it('anisotropic cells: area 6 m2 and volume 24 m3 for a one-cell pit 4 deep on 2 m by 3 m cells', () => {
    const { inv: r, cond, grid } = inv('depression-cases', 'anisotropic-bowl.json');
    expect(r.depressions.map((d) => [d.seedCell, d.cells, d.areaM2, d.maxFillDepth, d.outletElevation])).toEqual([[12, 1, 6, 4, 6]]);
    expect(cond.fillDepthSum * grid.cellMetresX * grid.cellMetresY).toBe(24);
  });
});

describe('metric figures are withheld when the horizontal scale is unresolved', () => {
  it('reports cell counts and depths but no area', () => {
    const g = read<Grid>(join(ROOT, 'fixtures', 'bowl-notched.json'));
    const r = runFlowPulse(flowDtmOf(g.z), { ...FLOW_PROJECTED_SCALE, resolved: false }, FLOW_PULSE_DEFAULTS, FLOW_TEST_IDENTITY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    MEASURED.unresolvedScale = { depressions: r.depressions.depressions, largestAreaM2: r.depressions.largestAreaM2 };
    expect(r.depressions.depressions).toHaveLength(1);
    expect(r.depressions.depressions[0].cells).toBe(1);
    expect(r.depressions.depressions[0].maxFillDepth).toBe(4);
    expect(r.depressions.depressions[0].areaM2).toBeNull();
    expect(r.depressions.largestAreaM2).toBeNull();
    expect(r.contributingAreaM2).toBeNull();
  });
});

describe('the exported ASCII grid reads back in place', () => {
  it('has no north-up flip and no half-cell shift', () => {
    // An asymmetric 3 x 4 grid, rows south first as Flow Pulse holds them.
    const southFirst = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ];
    const dtm = flowDtmOf(southFirst, { cellSizeM: 2 });
    const r = runFlowPulse(dtm, FLOW_PROJECTED_SCALE, { ...FLOW_PULSE_DEFAULTS, conditioning: 'raw' }, FLOW_TEST_IDENTITY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const zip = buildFlowPulsePackage(r, {
      basename: 'flow', generationDateIso: '2026-10-25T00:00:00.000Z',
      worldOrigin: { x: 1000, y: 2000 },
      gridFrame: { originH1: 10, originH2: 20, cellSize: 2 },
    });
    const lines = textOf(zip, 'flow-accumulation.asc').trim().split('\n');
    const header = Object.fromEntries(lines.slice(0, 6).map((l) => l.trim().split(/\s+/)).map(([k, v]) => [k.toLowerCase(), Number(v)]));
    const body = lines.slice(6).map((l) => l.trim().split(/\s+/).map(Number));
    MEASURED.roundTrip = { header, body };
    expect(header.ncols).toBe(4);
    expect(header.nrows).toBe(3);
    expect(header.cellsize).toBe(2);
    // Lower-left corner of the lower-left cell, not its centre.
    expect(header.xllcorner).toBe(1010);
    expect(header.yllcorner).toBe(2020);
    // The first text row is the northern row: Flow Pulse's last row.
    for (let tr = 0; tr < 3; tr++) {
      for (let c = 0; c < 4; c++) {
        expect(body[tr][c]).toBe(r.accumulation.upstreamCells[(2 - tr) * 4 + c]);
      }
    }
    // The grid falls toward its south-west corner, so the most upstream cells
    // collect there: on the last text row, in the first column.
    expect(body[2][0]).toBe(Math.max(...r.accumulation.upstreamCells));
  });
});
