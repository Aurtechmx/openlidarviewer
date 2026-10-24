/**
 * priorityFloodEpsilonChain.test.ts: a long filled flat drains through its
 * lowest exit, however close a competing exit is.
 *
 * Priority-Flood+ε places each filled cell one rise above the cell it was
 * reached from, so the rises add up along a flat and its far end sits
 * highest. On a Float32 surface one rise is 6.1e-5 m at 600 m, so a few
 * hundred cells climb past an exit only a centimetre above the true spill
 * point, and D8 drains the far part of the flat over that exit while every
 * count the run reports reads clean. The conditioned surface is Float64,
 * where the same chain climbs nanometres at most, and the flood is ordered
 * by the spill level without the epsilon, so the order it advances in cannot
 * depend on the chain either.
 *
 * The terrain is a walled lake three rows deep with two exits on opposite
 * edges: A at the lake level L, its true spill point, and B slightly higher.
 * The right answer is that no lake cell drains through B.
 */
import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { catchmentOf } from '../src/simulation/flowPulse/flowAccumulation';
import { catchmentFrom, FLOW_PULSE_DEFAULTS, runFlowPulse } from '../src/simulation/flowPulse/flowPulseRunner';
import { priorityFlood, type FillEpsilon } from '../src/simulation/flowPulse/priorityFlood';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';

/**
 * The lake, row-major with row 0 to the south: five rows by `len + 2`
 * columns, the three inner rows floored at `L - floorDrop`, walls at L + 1,
 * exit A on the west edge at L and exit B on the east edge at `exitB`.
 */
function lakeRows(L: number, len: number, exitB: number, floorDrop = 0): number[][] {
  const cols = len + 2;
  const out: number[][] = [];
  for (let r = 0; r < 5; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      if (c === 0 && r === 2) row.push(L);
      else if (c === cols - 1 && r === 2) row.push(exitB);
      else if (c === 0 || r === 0 || c === cols - 1 || r === 4) row.push(L + 1);
      else row.push(L - floorDrop);
    }
    out.push(row);
  }
  return out;
}

function lakeGrid(L: number, len: number, exitB: number): FlowGrid {
  const rows = lakeRows(L, len, exitB);
  const cols = len + 2;
  return {
    z: Float32Array.from(rows.flat()), valid: new Uint8Array(cols * 5).fill(1),
    cols, rows: 5, cellMetresX: 1, cellMetresY: 1,
  };
}

/** Lake cells (rows 1-3, columns 1..len) a catchment mask contains. */
function lakeCellsIn(mask: Uint8Array, len: number): number {
  const cols = len + 2;
  let count = 0;
  for (let row = 1; row <= 3; row++) {
    for (let c = 1; c <= len; c++) if (mask[row * cols + c] === 1) count++;
  }
  return count;
}

/** The next Float32 value above `x` (positive `x`), by moving the bit pattern. */
function nextFloat32Above(x: number): number {
  const f = new Float32Array([x]);
  new Int32Array(f.buffer)[0] += 1;
  return f[0];
}

/**
 * The five lakes the defect was measured on: lake level, flat length, how
 * far B sits above A, and how many of the lake's cells a Float32 surface
 * sends through B.
 */
const MEASURED: readonly (readonly [number, number, number, number])[] = [
  [600, 300, 0.01, 204],
  [600, 1000, 0.03, 762],
  [3000, 300, 0.03, 267],
  [3000, 1000, 0.1, 885],
  [30000, 300, 0.1, 375],
];

describe('a long flat drains through its lowest exit', () => {
  for (const [L, len, rise, wasToB] of MEASURED) {
    for (const floorDrop of [0, 0.5]) {
      const what = floorDrop === 0 ? 'a level flat' : 'a filled depression';
      it(`sends no cell of ${what} at ${L} m, ${len} cells long, over an exit ${rise} m higher (Float32: ${wasToB} of ${3 * len})`, () => {
        const cols = len + 2;
        const exitA = 2 * cols;
        const exitB = 2 * cols + cols - 1;
        const run = runFlowPulse(
          flowDtmOf(lakeRows(L, len, L + rise, floorDrop)), FLOW_PROJECTED_SCALE, FLOW_PULSE_DEFAULTS,
          FLOW_TEST_IDENTITY, 'm',
        );
        if (!run.ok) throw new Error(run.reason);
        expect(lakeCellsIn(catchmentFrom(run, exitB), len)).toBe(0);
        expect(lakeCellsIn(catchmentFrom(run, exitA), len)).toBe(3 * len);
        expect(run.summary.epsilonAbsorbed).toBe(0);
        expect(run.summary.sinkCount).toBe(0);
        expect(run.summary.flatCount).toBe(0);
      });
    }
  }
});

describe('the chain stays below the next height a Float32 DTM can hold', () => {
  it('drains 60,000 lake cells through A when B is a single Float32 step higher', () => {
    // The closest a competing exit can be on a Float32 DTM. The chain across
    // 20,000 columns at 3000 m climbs about 9e-9 m; the Float32 step is 2.4e-4 m.
    const L = 3000;
    const len = 20_000;
    const exitBHeight = nextFloat32Above(L);
    const g = lakeGrid(L, len, exitBHeight);
    const conditioned = priorityFlood(g, { epsilon: 'float64-step' });
    let maxRise = 0;
    for (let row = 1; row <= 3; row++) {
      for (let c = 1; c <= len; c++) maxRise = Math.max(maxRise, conditioned.z[row * (len + 2) + c] - L);
    }
    expect(maxRise).toBeGreaterThan(0);
    expect(maxRise).toBeLessThan((exitBHeight - L) / 1000);

    const routed = d8Flow({ ...g, z: conditioned.z });
    const exitB = 2 * (len + 2) + len + 1;
    expect(lakeCellsIn(catchmentOf(g, routed, exitB), len)).toBe(0);
    expect(routed.sinkCount).toBe(0);
    expect(routed.flatCount).toBe(0);
  });
});

/** Seeded generator, the mulberry32 used across this suite. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the flood order does not depend on the epsilon', () => {
  it('reaches every cell at the same spill level whatever the rise, over 500 random grids', () => {
    // Heights a few millimetres apart with plateaux among them, where a
    // flood ordered by the raised heights would let a large rise reach a
    // depression from the wrong rim first.
    const rand = mulberry32(20261024);
    const rises: readonly FillEpsilon[] = [1e-4, 0.001, 0.01, 0.1, 'float64-step'];
    for (let trial = 0; trial < 500; trial++) {
      const cols = 6 + Math.floor(rand() * 12);
      const rows = 6 + Math.floor(rand() * 12);
      const n = cols * rows;
      const z = new Float32Array(n);
      const valid = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        valid[i] = rand() < 0.1 ? 0 : 1;
        z[i] = 600 + Math.floor(rand() * 8) * 0.004;
      }
      const g: FlowGrid = { z, valid, cols, rows, cellMetresX: 1, cellMetresY: 1 };
      for (const noData of ['wall', 'outlet'] as const) {
        const exact = priorityFlood(g, { epsilon: 0, noData });
        for (const epsilon of rises) {
          const res = priorityFlood(g, { epsilon, noData });
          const label = `trial ${trial}, ${noData}, epsilon ${String(epsilon)}`;
          expect(Array.from(res.spillLevel), label).toEqual(Array.from(exact.spillLevel));
          expect(Array.from(res.depressionMask), label).toEqual(Array.from(exact.depressionMask));
          expect(res.cellsRaised, label).toBe(exact.cellsRaised);
          expect(res.fillDepthSum, label).toBe(exact.fillDepthSum);
          expect(res.cellsUnreachable, label).toBe(exact.cellsUnreachable);
        }
      }
    }
  });

  it('keeps the true spill level under a fixed rise, which still climbs past the nearby exit', () => {
    // The caveat a fixed rise carries, stated in the docs: the flood now
    // reaches every lake cell at A's level, but 300 rises of 1 mm put the
    // far end 0.3 m up, above B, and D8 sends that end through B.
    const L = 600;
    const len = 300;
    const g = lakeGrid(L, len, L + 0.01);
    const res = priorityFlood(g, { epsilon: 0.001 });
    for (let row = 1; row <= 3; row++) {
      for (let c = 1; c <= len; c++) expect(res.spillLevel[row * (len + 2) + c]).toBe(L);
    }
    const routed = d8Flow({ ...g, z: res.z });
    expect(lakeCellsIn(catchmentOf(g, routed, 2 * (len + 2) + len + 1), len)).toBeGreaterThan(0);
  });
});
