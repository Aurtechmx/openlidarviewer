/**
 * priorityFlood.test.ts: conditioning fills what it must and admits the rest.
 *
 * The properties asserted here are the ones a wrong implementation still
 * satisfies partially, which is why each is checked against a surface whose
 * spill level can be read off by eye:
 *
 *   the input is not modified
 *   a depression rises to its spill level and no further
 *   ground that already drains is left alone
 *   the conditioned surface actually has no interior pits left
 *   an epsilon absorbed by Float32 is reported rather than hidden
 *
 * The last one is the reason this file exists in its current shape. A test
 * suite that only checked "cellsRaised > 0" would pass on a surface that is
 * still full of unresolvable flats at a large coordinate magnitude.
 */
import { describe, expect, it } from 'vitest';

import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { filledCells, priorityFlood } from '../src/simulation/flowPulse/priorityFlood';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function gridOf(rows: readonly (readonly (number | null)[])[]): FlowGrid {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      valid[r * w + c] = 1;
    }
  }
  return { z, valid, cols: w, rows: h, cellMetresX: 1, cellMetresY: 1 };
}

/**
 * A pit at the centre of a 5×5 bowl, with a notch in the rim.
 *
 * The notch matters. A bowl ringed entirely at 5 has no outlet below 5, so
 * Priority-Flood correctly fills its whole interior to 5 and every inner cell
 * is raised. That is a real answer but a poor test: it cannot distinguish
 * filling to the spill level from filling to the rim. The notch at 3 gives
 * the interior a genuine way out, so the pit fills to the inner ring at 4 and
 * stops, and only the pit itself rises.
 */
const bowl = () => gridOf([
  [5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5],
]);

describe('the canonical surface is never modified', () => {
  it('leaves the input grid exactly as it was', () => {
    const g = bowl();
    const before = Float32Array.from(g.z);
    priorityFlood(g, { epsilon: 0.001 });
    expect([...g.z]).toEqual([...before]);
  });
});

describe('a depression rises to its spill level', () => {
  it('fills the pit and reports the depth it filled', () => {
    const g = bowl();
    const res = priorityFlood(g);
    const centre = 2 * 5 + 2;
    // The pit at 0 is ringed by 4s and one 3; it fills to the lowest level
    // that lets it escape, which is the 4 surrounding it.
    expect(res.z[centre]).toBeCloseTo(4, 5);
    expect(res.maxFillDepth).toBeCloseTo(4, 5);
    expect(res.cellsRaised).toBe(1);
  });

  it('marks exactly the cells it raised', () => {
    const g = bowl();
    const mask = filledCells(g, priorityFlood(g));
    expect([...mask].filter((v) => v === 1)).toEqual([1]);
    expect(mask[2 * 5 + 2]).toBe(1);
  });

  it('leaves a surface that already drains untouched', () => {
    // A plane falling east has no depression anywhere.
    const g = gridOf([
      [3, 2, 1, 0],
      [3, 2, 1, 0],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsRaised).toBe(0);
    expect([...res.z]).toEqual([...g.z]);
  });
});

describe('the conditioned surface drains', () => {
  it('has no interior sink left once an epsilon breaks the plateau', () => {
    const g = bowl();
    const res = priorityFlood(g, { epsilon: 0.001 });
    const conditioned: FlowGrid = { ...g, z: res.z };
    expect(d8Flow(conditioned).sinkCount).toBe(0);
    expect(res.epsilonAbsorbed).toBe(0);
  });

  it('still reports a sink when filling to the exact spill level', () => {
    // Without an epsilon the pit becomes level with its neighbours, which is
    // a flat rather than a descent. Worth pinning: it is the reason the
    // epsilon exists, and a caller choosing zero should know what it gets.
    const g = bowl();
    const res = priorityFlood(g, { epsilon: 0 });
    const conditioned: FlowGrid = { ...g, z: res.z };
    const routed = d8Flow(conditioned);
    expect(routed.sinkCount + routed.flatCount).toBeGreaterThan(0);
  });
});

describe('an absorbed epsilon is reported, not hidden', () => {
  it('counts increments Float32 cannot represent at a large magnitude', () => {
    // At 5e6 metres the gap between neighbouring Float32 values is about
    // 0.5 m, so a millimetre epsilon cannot move the value at all. The fill
    // still happens; what fails is the hair of descent on top of it.
    const base = 5_000_000;
    const g = gridOf([
      [base + 5, base + 5, base + 5],
      [base + 5, base + 0, base + 5],
      [base + 5, base + 5, base + 5],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsRaised).toBe(1);
    expect(res.epsilonAbsorbed).toBeGreaterThan(0);
  });

  it('reports none at an ordinary magnitude, so the count means something', () => {
    // The discrimination case. If this also reported absorptions the counter
    // would be measuring the wrong thing.
    expect(priorityFlood(bowl(), { epsilon: 0.001 }).epsilonAbsorbed).toBe(0);
  });
});

describe('NoData bounds the flood', () => {
  it('drains a pit to a NoData hole rather than filling it to the rim', () => {
    // The hole is an edge of the mapped surface, so the pit beside it spills
    // there and never rises to the outer rim.
    const g = gridOf([
      [9, 9, 9, 9],
      [9, 1, null, 9],
      [9, 9, 9, 9],
    ]);
    const res = priorityFlood(g);
    expect(res.cellsRaised).toBe(0);
  });

  it('treats a cell enclosed by NoData as already at an edge', () => {
    // A cell touching NoData is a place water leaves the mapped surface, so
    // it seeds the flood at its own elevation and is never raised. Filling it
    // would invent terrain on the far side of the hole.
    const g = gridOf([
      [null, null, null],
      [null, 2, null],
      [null, null, null],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsRaised).toBe(0);
    expect(res.z[4]).toBeCloseTo(2, 6);
  });
});

describe('the result is reproducible', () => {
  it('produces identical surfaces across runs on a symmetric terrain', () => {
    // Symmetry is where an order-dependent heap shows up: several cells sit
    // at the same elevation and something has to choose between them.
    const symmetric = gridOf([
      [4, 4, 4, 4, 4],
      [4, 1, 1, 1, 4],
      [4, 1, 0, 1, 4],
      [4, 1, 1, 1, 4],
      [4, 4, 4, 4, 4],
    ]);
    const a = priorityFlood(symmetric, { epsilon: 0.01 });
    const b = priorityFlood(symmetric, { epsilon: 0.01 });
    expect([...a.z]).toEqual([...b.z]);
    expect(a.cellsRaised).toBe(b.cellsRaised);
  });
});

describe('the options are checked', () => {
  it('refuses a negative epsilon, which would lower cells', () => {
    expect(() => priorityFlood(bowl(), { epsilon: -1 })).toThrow(/non-negative/);
  });
});
