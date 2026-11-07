/**
 * divideTrace.test.ts — a catchment mask traced to a closed divide ring, the
 * NoData holes it encloses, and Douglas-Peucker simplification of the ring.
 *
 * Every mask is drawn by hand, so each expected length and vertex count can be
 * read straight off the picture.
 */
import { describe, expect, it } from 'vitest';
import { douglasPeucker, traceDivide } from '../src/simulation/flowPulse/watershed/divideTrace';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function gridOf(cols: number, rows: number, cellMetresX = 1, cellMetresY = 1): FlowGrid {
  return {
    z: new Float32Array(cols * rows),
    valid: new Uint8Array(cols * rows).fill(1),
    cols, rows, cellMetresX, cellMetresY,
  };
}

/** Mask with every cell for which `inside(col, row)` is true. */
function maskOf(grid: FlowGrid, inside: (c: number, r: number) => boolean): Uint8Array {
  const mask = new Uint8Array(grid.cols * grid.rows);
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) if (inside(c, r)) mask[r * grid.cols + c] = 1;
  }
  return mask;
}

function pairs(ring: Float64Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i += 2) out.push([ring[i], ring[i + 1]]);
  return out;
}

function ringLength(ring: Float64Array): number {
  let len = 0;
  for (let i = 2; i < ring.length; i += 2) len += Math.hypot(ring[i] - ring[i - 2], ring[i + 1] - ring[i - 1]);
  return len;
}

describe('traceDivide', () => {
  it('traces a square block to its four corners', () => {
    const grid = gridOf(10, 10);
    const mask = maskOf(grid, (c, r) => c >= 3 && c < 7 && r >= 2 && r < 6);
    const divide = traceDivide(grid, mask);
    expect(divide.rawPerimeterM).toBe(16);
    expect(divide.perimeterM).toBeCloseTo(16, 9);
    expect(divide.outer.length).toBe(10); // 5 coordinate pairs, first equals last
    const p = pairs(divide.outer);
    expect(p[0]).toEqual(p[4]);
    expect(new Set(p.slice(0, 4).map(([x, y]) => `${x},${y}`))).toEqual(
      new Set(['3,2', '7,2', '7,6', '3,6']),
    );
    expect(divide.holes).toHaveLength(0);
    expect(divide.enclosedHoleCells).toBe(0);
    expect(divide.degenerate).toBe(false);
  });

  it('puts coordinates in metres from the south-west corner, with row 0 southmost', () => {
    const grid = gridOf(6, 6, 2, 3);
    const mask = maskOf(grid, (c, r) => c >= 1 && c < 3 && r >= 0 && r < 2);
    const divide = traceDivide(grid, mask);
    const xs = pairs(divide.outer).map(([x]) => x);
    const ys = pairs(divide.outer).map(([, y]) => y);
    expect(Math.min(...xs)).toBe(2);
    expect(Math.max(...xs)).toBe(6);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(6);
    expect(divide.rawPerimeterM).toBe(2 * 4 + 2 * 6);
  });

  it('keeps holes enclosed by the mask and counts their cells', () => {
    const grid = gridOf(12, 12);
    const inBlock = (c: number, r: number) => c >= 2 && c < 10 && r >= 2 && r < 10;
    const inHole = (c: number, r: number) => c >= 4 && c < 7 && r >= 4 && r < 6; // 3 × 2
    for (let r = 0; r < 12; r++) {
      for (let c = 0; c < 12; c++) if (inHole(c, r)) grid.valid[r * 12 + c] = 0;
    }
    const mask = maskOf(grid, (c, r) => inBlock(c, r) && !inHole(c, r));
    const divide = traceDivide(grid, mask);
    expect(divide.enclosedHoleCells).toBe(6);
    expect(divide.holes).toHaveLength(1);
    const hole = pairs(divide.holes[0]);
    expect(hole[0]).toEqual(hole[hole.length - 1]);
    expect(new Set(hole.slice(0, -1).map(([x, y]) => `${x},${y}`))).toEqual(
      new Set(['4,4', '7,4', '7,6', '4,6']),
    );
    // The outer ring still runs round the whole block, hole included.
    expect(divide.rawPerimeterM).toBe(32);
    expect(divide.degenerate).toBe(false);
  });

  it('does not count masked-out valid cells inside the ring as holes', () => {
    const grid = gridOf(12, 12);
    const inBlock = (c: number, r: number) => c >= 2 && c < 10 && r >= 2 && r < 10;
    const inOther = (c: number, r: number) => c >= 4 && c < 6 && r >= 4 && r < 6; // valid, another catchment
    const mask = maskOf(grid, (c, r) => inBlock(c, r) && !inOther(c, r));
    const divide = traceDivide(grid, mask);
    expect(divide.enclosedHoleCells).toBe(0);
    expect(divide.holes).toHaveLength(0);
  });

  it('leaves NoData that reaches the outside of the ring as a notch, not a hole', () => {
    const grid = gridOf(12, 12);
    // A U-shaped mask whose open side faces north; the NoData in the U is not enclosed.
    const mask = maskOf(grid, (c, r) => c >= 2 && c < 8 && r >= 2 && r < 8 && !(c >= 4 && c < 6 && r >= 4));
    for (let r = 4; r < 8; r++) for (let c = 4; c < 6; c++) grid.valid[r * 12 + c] = 0;
    const divide = traceDivide(grid, mask);
    expect(divide.enclosedHoleCells).toBe(0);
    expect(divide.holes).toHaveLength(0);
  });

  it('treats cells that touch only at a corner as one piece', () => {
    const grid = gridOf(6, 6);
    const mask = maskOf(grid, (c, r) => (c === 1 && r === 1) || (c === 2 && r === 2));
    const divide = traceDivide(grid, mask);
    expect(divide.rawPerimeterM).toBe(8); // two unit squares sharing a corner vertex
    expect(divide.holes).toHaveLength(0);
  });

  it('traces only the largest piece when the mask is split', () => {
    const grid = gridOf(20, 10);
    const mask = maskOf(grid, (c, r) => (c >= 1 && c < 4 && r >= 1 && r < 4) || (c >= 10 && c < 16 && r >= 1 && r < 6));
    const divide = traceDivide(grid, mask);
    expect(divide.rawPerimeterM).toBe(2 * (6 + 5));
  });

  it('reduces the staircase bias of a diagonal boundary', () => {
    const side = 50;
    const grid = gridOf(60, 60);
    // Right angle at the south-east; the hypotenuse is the staircase from south-west to north-east.
    const mask = maskOf(grid, (c, r) => c < side && r <= c);
    const divide = traceDivide(grid, mask);
    // The two legs of 50 m are straight; only the hypotenuse is a staircase.
    const legs = 2 * side;
    expect(divide.rawPerimeterM).toBe(legs + 2 * side);
    const ratio = (divide.rawPerimeterM - legs) / (divide.perimeterM - legs);
    expect(ratio).toBeGreaterThan(1.35);
    expect(ratio).toBeLessThan(1.42);
    expect(divide.degenerate).toBe(false);
  });

  it('keeps the simplified perimeter within a cell of the true outline whichever way the diagonal faces', () => {
    const side = 50;
    const grid = gridOf(60, 60);
    const trueOutline = 2 * side + side * Math.SQRT2;
    const facing = [
      maskOf(grid, (c, r) => c < side && r <= c),
      maskOf(grid, (c, r) => c < side && r < side && c + r < side),
      maskOf(grid, (c, r) => c < side && r < side && c <= r),
      maskOf(grid, (c, r) => c < side && r < side && c + r >= side - 1),
    ];
    for (const mask of facing) {
      const divide = traceDivide(grid, mask);
      expect(Math.abs(divide.perimeterM - trueOutline)).toBeLessThanOrEqual(1.5);
    }
  });

  it('flags a one-cell and a two-cell mask as degenerate without throwing', () => {
    const grid = gridOf(6, 6);
    const one = traceDivide(grid, maskOf(grid, (c, r) => c === 2 && r === 2));
    expect(one.degenerate).toBe(true);
    expect(one.rawPerimeterM).toBe(4);
    const two = traceDivide(grid, maskOf(grid, (c, r) => (c === 2 || c === 3) && r === 2));
    expect(two.degenerate).toBe(true);
    expect(two.rawPerimeterM).toBe(6);
  });

  it('returns an empty, degenerate divide for an empty mask', () => {
    const grid = gridOf(4, 4);
    const divide = traceDivide(grid, new Uint8Array(16));
    expect(divide.degenerate).toBe(true);
    expect(divide.outer.length).toBe(0);
    expect(divide.rawPerimeterM).toBe(0);
    expect(divide.perimeterM).toBe(0);
  });

  it('rejects a mask of the wrong size', () => {
    expect(() => traceDivide(gridOf(4, 4), new Uint8Array(3))).toThrow(RangeError);
  });

  it('accounts for every exposed cell edge on random masks, with corner contacts and pockets', () => {
    // With every cell outside the largest piece set to NoData, the outer ring plus
    // the hole rings (unsimplified, tolerance 0) must cover each cell side of the
    // piece that faces a non-piece cell, exactly once.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const cols = 14;
    const rows = 12;
    const n = cols * rows;
    let casesWithHoles = 0;
    for (let trial = 0; trial < 300; trial++) {
      const fill = 0.45 + rnd() * 0.25;
      const raw = new Uint8Array(n);
      for (let i = 0; i < n; i++) raw[i] = rnd() < fill ? 1 : 0;
      // Largest 8-connected piece, found the slow obvious way.
      const label = new Int32Array(n).fill(-1);
      let best = -1;
      let bestSize = 0;
      for (let seedCell = 0, id = 0; seedCell < n; seedCell++) {
        if (raw[seedCell] === 0 || label[seedCell] >= 0) continue;
        const todo = [seedCell];
        label[seedCell] = id;
        let size = 0;
        while (todo.length > 0) {
          const i = todo.pop() as number;
          size++;
          const c = i % cols;
          const r = (i - c) / cols;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
              const j = rr * cols + cc;
              if (raw[j] === 1 && label[j] < 0) { label[j] = id; todo.push(j); }
            }
          }
        }
        if (size > bestSize) { bestSize = size; best = id; }
        id++;
      }
      if (best < 0) continue;
      const piece = new Uint8Array(n);
      for (let i = 0; i < n; i++) piece[i] = label[i] === best ? 1 : 0;
      let exposed = 0;
      for (let i = 0; i < n; i++) {
        if (piece[i] === 0) continue;
        const c = i % cols;
        const r = (i - c) / cols;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || cc >= cols || rr < 0 || rr >= rows || piece[rr * cols + cc] === 0) exposed++;
        }
      }
      const grid: FlowGrid = { ...gridOf(cols, rows), valid: piece.slice() };
      const divide = traceDivide(grid, raw, 0);
      let covered = divide.rawPerimeterM;
      for (const hole of divide.holes) covered += ringLength(hole);
      expect(covered).toBeCloseTo(exposed, 9);
      if (divide.enclosedHoleCells > 0) casesWithHoles++;
    }
    expect(casesWithHoles).toBeGreaterThan(50);
  });

  it('uses a tolerance of one cell by default and honours an explicit one', () => {
    const grid = gridOf(12, 12);
    // A block with a one-cell bite out of one side: the bite is within one cell, so it simplifies away.
    const mask = maskOf(grid, (c, r) => c >= 2 && c < 10 && r >= 2 && r < 10 && !(c === 5 && r === 9));
    const loose = traceDivide(grid, mask);
    const tight = traceDivide(grid, mask, 0.25);
    expect(tight.outer.length).toBeGreaterThan(loose.outer.length);
    expect(tight.perimeterM).toBeCloseTo(tight.rawPerimeterM, 9);
  });
});

describe('douglasPeucker', () => {
  it('keeps endpoints and drops points within tolerance', () => {
    const line = new Float64Array([0, 0, 1, 0.1, 2, -0.1, 3, 0.05, 4, 0]);
    const out = douglasPeucker(line, 0.5);
    expect(Array.from(out)).toEqual([0, 0, 4, 0]);
  });

  it('keeps a point that sticks out further than the tolerance', () => {
    const line = new Float64Array([0, 0, 2, 3, 4, 0]);
    expect(Array.from(douglasPeucker(line, 0.5))).toEqual([0, 0, 2, 3, 4, 0]);
    expect(Array.from(douglasPeucker(line, 5))).toEqual([0, 0, 4, 0]);
  });

  it('simplifies a closed ring from its start vertex and the vertex farthest from it', () => {
    // A square with a tiny bump on the south side.
    const ring = new Float64Array([0, 0, 5, 0.2, 10, 0, 10, 10, 0, 10, 0, 0]);
    const out = douglasPeucker(ring, 0.5);
    expect(Array.from(out)).toEqual([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
  });

  it('returns short rings unchanged', () => {
    const tiny = new Float64Array([1, 1, 2, 2]);
    expect(Array.from(douglasPeucker(tiny, 1))).toEqual([1, 1, 2, 2]);
    expect(douglasPeucker(new Float64Array(0), 1).length).toBe(0);
  });

  it('never lengthens a ring', () => {
    const ring = new Float64Array([0, 0, 3, 1, 6, 0, 9, 2, 12, 0, 12, 8, 0, 8, 0, 0]);
    expect(ringLength(douglasPeucker(ring, 1))).toBeLessThanOrEqual(ringLength(ring) + 1e-9);
  });
});
