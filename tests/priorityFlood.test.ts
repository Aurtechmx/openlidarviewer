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
 *   a rise too small to represent is reported rather than hidden
 *   NoData is a wall, as routing reads it, unless a gap is declared an exit
 *
 * A test suite that only checked "cellsRaised > 0" would pass on a surface
 * that is still full of unresolvable flats, which is why the absorbed rise
 * is pinned at a height where it really is absorbed. The epsilon chain along
 * a long flat, and the flood order that must not depend on it, are pinned in
 * `priorityFloodEpsilonChain.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { CELL_ROUTED, CELL_SINK, d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { CELL_OUTLET } from '../src/simulation/flowPulse/flowTypes';
import { filledCells, nextFloat64Up, priorityFlood } from '../src/simulation/flowPulse/priorityFlood';
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
  // A pit at 600 m. The conditioned surface is Float64, where neighbouring
  // values at 600 m are 1.1e-13 apart.
  const pit = () => gridOf([
    [605, 605, 605],
    [605, 600, 605],
    [605, 605, 605],
  ]);

  it('counts a fixed rise below the Float64 spacing at that height', () => {
    // 1e-14 m is under half that spacing, so adding it cannot move the
    // value at all. The fill still happens; what fails is the hair of
    // descent on top of it, and D8 then finds the filled cell flat.
    const g = pit();
    const res = priorityFlood(g, { epsilon: 1e-14 });
    expect(res.cellsRaised).toBe(1);
    expect(res.epsilonAbsorbed).toBe(1);
    expect(d8Flow({ ...g, z: res.z }).flatCount).toBeGreaterThan(0);
  });

  it('reports none at an ordinary magnitude, so the count means something', () => {
    // The discrimination case. If this also reported absorptions the counter
    // would be measuring the wrong thing.
    expect(priorityFlood(bowl(), { epsilon: 0.001 }).epsilonAbsorbed).toBe(0);
    expect(priorityFlood(pit(), { epsilon: 0.001 }).epsilonAbsorbed).toBe(0);
  });

  it('no longer loses a millimetre at a projected coordinate magnitude, as Float32 did', () => {
    // At 5e6 m neighbouring Float32 values are 0.5 m apart, so a Float32
    // surface absorbed a millimetre here. Float64 values are 9.3e-10 m apart.
    const base = 5_000_000;
    const g = gridOf([
      [base + 5, base + 5, base + 5],
      [base + 5, base + 0, base + 5],
      [base + 5, base + 5, base + 5],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsRaised).toBe(1);
    expect(res.epsilonAbsorbed).toBe(0);
    expect(res.z[4]).toBe(base + 5 + 0.001);
  });
});

/**
 * A surface falling east, with a survey hole beside a two-cell depression.
 *
 * The plane is `10 − col`, so the east boundary at 4 is where water leaves.
 * The depression at row 2 (4 at col 1, 3 at col 2) sits against a one-cell
 * hole at col 3. Its lowest way out through measured ground is past the hole,
 * over the 7s at cols 3 of rows 1 and 3, so its true spill level is 7.
 */
const holeSlope = () => gridOf([
  [10, 9, 8, 7, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
  [10, 4, 3, null, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
  [10, 9, 8, 7, 6, 5, 4],
]);
const HOLE_COLS = 7;
const DEPRESSION_LOW = 2 * HOLE_COLS + 2;
const DEPRESSION_HIGH = 2 * HOLE_COLS + 1;
const HOLE = 2 * HOLE_COLS + 3;

/** The valid cells touching `cell`, which is what "the hole's rim" means. */
function rimOf(g: FlowGrid, cell: number): number[] {
  const col = cell % g.cols;
  const row = (cell - col) / g.cols;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = col + dx;
      const r = row + dy;
      if ((dx === 0 && dy === 0) || c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
      if (g.valid[r * g.cols + c] === 1) out.push(r * g.cols + c);
    }
  }
  return out;
}

/**
 * A pit inside a closed ring of NoData, inside a measured frame.
 *
 * The nine inner cells have no path of measured cells to the grid boundary,
 * so no flood from the boundary can reach them.
 */
const island = () => gridOf([
  [9, 9, 9, 9, 9, 9, 9],
  [9, null, null, null, null, null, 9],
  [9, null, 5, 5, 5, null, 9],
  [9, null, 5, 1, 5, null, 9],
  [9, null, 5, 5, 5, null, 9],
  [9, null, null, null, null, null, 9],
  [9, 9, 9, 9, 9, 9, 9],
]);

describe('NoData is a wall by default, as routing reads it', () => {
  it('fills a depression beside a hole to its spill level toward the boundary', () => {
    const g = holeSlope();
    const res = priorityFlood(g, { epsilon: 0.001 });
    // Both depression cells rise past the hole to the 7s, the lowest measured
    // way out, and the upper one sits one epsilon above the lower.
    expect(res.z[DEPRESSION_LOW]).toBeCloseTo(7.001, 4);
    expect(res.z[DEPRESSION_HIGH]).toBeCloseTo(7.002, 4);
    expect(res.cellsRaised).toBe(2);
    // Spill level (7) minus original height (3): the epsilon chain is not depth.
    expect(res.maxFillDepth).toBeCloseTo(4, 6);
    expect(res.cellsUnreachable).toBe(0);
  });

  it('leaves no sink on the rim of the hole once routed', () => {
    const g = holeSlope();
    const routed = d8Flow({ ...g, z: priorityFlood(g, { epsilon: 0.001 }).z });
    expect(routed.sinkCount).toBe(0);
    expect(routed.flatCount).toBe(0);
    for (const cell of rimOf(g, HOLE)) expect(routed.status[cell]).toBe(CELL_ROUTED);
  });

  it('is the default, so a caller that names nothing gets the wall', () => {
    const g = holeSlope();
    expect([...priorityFlood(g, { epsilon: 0.001 }).z])
      .toEqual([...priorityFlood(g, { epsilon: 0.001, noData: 'wall' }).z]);
  });

  it('fills a pit that only a hole could have drained up to the boundary rim', () => {
    const g = gridOf([
      [9, 9, 9, 9],
      [9, 1, null, 9],
      [9, 9, 9, 9],
    ]);
    const res = priorityFlood(g);
    expect(res.cellsRaised).toBe(1);
    expect(res.z[5]).toBeCloseTo(9, 6);
  });
});

describe('a region NoData encloses is counted, not conditioned', () => {
  it('leaves an enclosed island as it is and reports how many cells it holds', () => {
    const g = island();
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsUnreachable).toBe(9);
    expect(res.cellsRaised).toBe(0);
    expect([...res.z]).toEqual([...g.z]);
    // The pit inside is still a pit: nothing claims to have resolved it.
    expect(d8Flow({ ...g, z: res.z }).status[3 * 7 + 3]).toBe(CELL_SINK);
  });

  it('counts a single cell enclosed on every side', () => {
    // The gap around it is itself enclosed by the surface, so it is a hole in
    // the survey, not ground outside it.
    const g = gridOf([
      [5, 5, 5, 5, 5],
      [5, null, null, null, 5],
      [5, null, 2, null, 5],
      [5, null, null, null, 5],
      [5, 5, 5, 5, 5],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsUnreachable).toBe(1);
    expect(res.cellsRaised).toBe(0);
    expect(res.z[12]).toBeCloseTo(2, 6);
  });

  it('drains an island in NoData that reaches the grid edge, since that NoData is outside the survey', () => {
    const g = gridOf([
      [null, null, null],
      [null, 2, null],
      [null, null, null],
    ]);
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.cellsUnreachable).toBe(0);
    expect(d8Flow(g).status[4]).toBe(CELL_OUTLET);
  });

  it('counts nothing where every cell reaches the boundary', () => {
    expect(priorityFlood(bowl(), { epsilon: 0.001 }).cellsUnreachable).toBe(0);
  });
});

describe('treating a gap as a drainage exit is a declared option', () => {
  it('drains the depression into the hole instead of filling it', () => {
    // The reading appropriate where a gap is open water: the cell on the rim
    // is an exit, so it seeds the flood at its own elevation and nothing
    // behind it rises.
    const g = holeSlope();
    const res = priorityFlood(g, { epsilon: 0.001, noData: 'outlet' });
    expect(res.cellsRaised).toBe(0);
    expect(res.maxFillDepth).toBe(0);
    expect(res.cellsUnreachable).toBe(0);
    expect([...res.z]).toEqual([...g.z]);
  });

  it('leaves the rim cell a sink under routing, which never enters NoData', () => {
    const g = holeSlope();
    const routed = d8Flow({ ...g, z: priorityFlood(g, { epsilon: 0.001, noData: 'outlet' }).z });
    expect(routed.sinkCount).toBe(1);
    expect(routed.status[DEPRESSION_LOW]).toBe(CELL_SINK);
  });

  it('seeds the rim of every gap, so no region is left unreachable', () => {
    const g = island();
    const res = priorityFlood(g, { epsilon: 0.001, noData: 'outlet' });
    expect(res.cellsUnreachable).toBe(0);
    expect(res.cellsRaised).toBe(1);
    expect(res.z[3 * 7 + 3]).toBeCloseTo(5.001, 4);
  });

  it('drains a pit to a NoData hole rather than filling it to the rim', () => {
    const g = gridOf([
      [9, 9, 9, 9],
      [9, 1, null, 9],
      [9, 9, 9, 9],
    ]);
    const res = priorityFlood(g, { noData: 'outlet' });
    expect(res.cellsRaised).toBe(0);
  });

  it('matches the wall exactly on a surface with no NoData', () => {
    const a = priorityFlood(bowl(), { epsilon: 0.001, noData: 'wall' });
    const b = priorityFlood(bowl(), { epsilon: 0.001, noData: 'outlet' });
    expect([...a.z]).toEqual([...b.z]);
    expect(a.cellsRaised).toBe(b.cellsRaised);
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

  it('refuses the Float32 step it replaced, and names the replacement', () => {
    const old = 'float32-step' as unknown as 'float64-step';
    expect(() => priorityFlood(bowl(), { epsilon: old })).toThrow(/'float32-step' was replaced by 'float64-step'/);
  });

  it('refuses a NoData reading it does not know', () => {
    const noData = 'edge' as unknown as 'wall';
    expect(() => priorityFlood(bowl(), { noData })).toThrow(/wall.*outlet/);
  });
});

/** The same Float64 step computed from the 64-bit pattern as a BigInt, for comparison. */
function nextUpByBigInt(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  const f = new Float64Array([x]);
  const bits = new BigInt64Array(f.buffer);
  bits[0] += x > 0 ? 1n : -1n;
  return f[0];
}

describe('the Float64-step rise', () => {
  it('steps to the next Float64 value above, through zero, for negatives and subnormals', () => {
    const cases = [1, 10.0035, 603.25, -2.5, 1e-30, 300_000.5, 4_117_519.25, Math.fround(600.1),
      2 ** 52 - 1, 2 ** 31, -(2 ** 32), 5e-324, 2.2250738585072014e-308, -2.2250738585072014e-308,
      1 - Number.EPSILON / 2, -1];
    for (const x of cases) {
      const up = nextFloat64Up(x);
      expect(up, `${x}`).toBeGreaterThan(x);
      expect(up, `${x}`).toBe(nextUpByBigInt(x));
      // Nothing Float64 lies strictly between.
      const mid = x / 2 + up / 2;
      expect(mid === x || mid === up, `${x}`).toBe(true);
    }
    // The low word carries into the high word and borrows back out of it.
    expect(nextFloat64Up(1 + 2 ** -20 - 2 ** -52)).toBe(1 + 2 ** -20);
    expect(nextFloat64Up(-(1 + 2 ** -20))).toBe(-(1 + 2 ** -20 - 2 ** -52));
    expect(nextFloat64Up(0)).toBe(5e-324);
    expect(nextFloat64Up(-0)).toBe(5e-324);
    expect(Object.is(nextFloat64Up(-5e-324), -0)).toBe(true);
    expect(nextFloat64Up(Number.MAX_VALUE)).toBe(Infinity);
    expect(nextFloat64Up(-Infinity)).toBe(-Number.MAX_VALUE);
    expect(nextFloat64Up(Infinity)).toBe(Infinity);
    expect(nextFloat64Up(Number.NaN)).toBeNaN();
  });

  it('agrees with the BigInt bit step over 20,000 random doubles of every sign and scale', () => {
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 20_000; i++) {
      const x = (rand() < 0.5 ? -1 : 1) * rand() * 2 ** Math.floor(rand() * 2100 - 1075);
      expect(nextFloat64Up(x)).toBe(nextUpByBigInt(x));
    }
  });

  // Row 1 holds the only routes: an outlet at 10 on the west edge, a flat run
  // at 10, a lip n at 10.0035, a pit p at 9, and an edge cell r at 10.004 on
  // the east. Water in p spills over n, the lower rim.
  const W = 100;
  const lip = (): FlowGrid => gridOf([
    [W, W, W, W, W, W, W, W, W, W],
    [10, 10, 10, 10, 10, 10, 10, 10.0035, 9, 10.004],
    [W, W, W, W, W, W, W, W, W, W],
  ]);
  const p = 1 * 10 + 8;
  const n = 1 * 10 + 7;
  const r = 1 * 10 + 9;

  it('spills a depression at its true level and over the lower rim', () => {
    const g = lip();
    const exact = priorityFlood(g, { epsilon: 0 });
    const res = priorityFlood(g, { epsilon: 'float64-step' });
    expect(res.spillLevel[p]).toBe(exact.spillLevel[p]);
    expect(res.spillLevel[p]).toBe(Math.fround(10.0035));
    expect(res.epsilonAbsorbed).toBe(0);
    const routed = d8Flow({ ...g, z: res.z });
    expect(routed.receiver[p]).toBe(n);
    expect(routed.sinkCount).toBe(0);
    expect(routed.flatCount).toBe(0);
  });

  it('a fixed 1 mm rise keeps the true spill level but still drains the pit over the higher rim', () => {
    // The flood is ordered by spill level, so a fixed rise no longer reaches
    // p from r first and overstates its level (the Float32 surface did:
    // 10.004). The rises still chain along the flat, though, six of them by
    // the time they reach n, which puts p above r and lets D8 send it east.
    // That is the reason a fixed rise is not the default.
    const g = lip();
    const res = priorityFlood(g, { epsilon: 0.001 });
    expect(res.spillLevel[p]).toBe(Math.fround(10.0035));
    expect(d8Flow({ ...g, z: res.z }).receiver[p]).toBe(r);
  });

  it('is never absorbed, even where a fixed rise is', () => {
    // At 300 km neighbouring Float64 values are 5.8e-11 m apart, so a fixed
    // 1e-12 m rise vanishes; the step is one of those gaps by definition.
    const g = gridOf([
      [300_000, 300_000, 300_000],
      [300_000, 299_000, 300_000],
      [300_000, 300_000, 300_000],
    ]);
    expect(priorityFlood(g, { epsilon: 1e-12 }).epsilonAbsorbed).toBeGreaterThan(0);
    const res = priorityFlood(g, { epsilon: 'float64-step' });
    expect(res.epsilonAbsorbed).toBe(0);
    expect(d8Flow({ ...g, z: res.z }).flatCount).toBe(0);
  });
});
