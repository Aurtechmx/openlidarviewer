/**
 * priorityFloodRandomGrids.test.ts: the wall/outlet properties hold at scale.
 *
 * `priorityFlood.test.ts` pins the two readings on grids small enough to
 * check by eye. What it cannot show is that `cellsUnreachable` and the
 * outlet-reproduces-the-old-seeding claim hold generally rather than on the
 * handful of shapes a person thought to draw. This sweeps random grids and
 * checks each reading against a reference computed a different way:
 *
 *   outlet matches a standalone reimplementation of the seeding this branch
 *     replaced (every boundary cell and every cell touching NoData is a
 *     seed), field for field, bit for bit
 *   `cellsUnreachable` under the wall matches a plain breadth-first search
 *     flood-fill from the boundary, run with its own queue rather than the
 *     conditioning pass's heap
 *   every cell the wall's BFS marks reachable comes back from D8 as neither
 *     a sink nor a flat
 *
 * Randomness is seeded (mulberry32, the generator used elsewhere in this
 * suite), so a failure names a seed that reproduces it exactly.
 */
import { describe, expect, it } from 'vitest';

import { CELL_FLAT, CELL_SINK, d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { D8_NEIGHBOURS, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { priorityFlood } from '../src/simulation/flowPulse/priorityFlood';

/** Deterministic PRNG — the same generator the decode-pool fuzz test uses. */
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

/**
 * A random surface with a NoData fraction in `[minGap, maxGap]`.
 *
 * Elevations are small integers, not because the algorithm cares but because
 * this run also checks that no epsilon rise is absorbed by Float32
 * precision: that failure mode belongs to large magnitudes, pinned
 * separately in `priorityFlood.test.ts`, and folding it in here would make a
 * sink/flat found on a reached cell ambiguous between the two causes.
 */
function randomGrid(rand: () => number, cols: number, rows: number, minGap: number, maxGap: number): FlowGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  const valid = new Uint8Array(n);
  const gapFraction = minGap + rand() * (maxGap - minGap);
  for (let i = 0; i < n; i++) {
    valid[i] = rand() < gapFraction ? 0 : 1;
    z[i] = Math.floor(rand() * 21); // 0..20: small, so a 0.01 epsilon is never absorbed
  }
  return { z, valid, cols, rows, cellMetresX: 1, cellMetresY: 1 };
}

/**
 * The seeding `priorityFlood` used before this branch: every boundary cell
 * and every cell touching NoData is a seed, unconditionally. Reimplemented
 * standalone, from the pre-fix source, rather than imported, so this check
 * does not exercise the same `noData` branch it is meant to verify against.
 */
function earlierSeedingFlood(grid: FlowGrid, epsilon: number): {
  z: Float32Array;
  cellsRaised: number;
  maxFillDepth: number;
  fillDepthSum: number;
  epsilonAbsorbed: number;
} {
  const { z: source, valid, cols, rows } = grid;
  const n = cols * rows;
  const z = new Float32Array(source);
  const closed = new Uint8Array(n);

  const isEdgeSeed = (col: number, row: number): boolean => {
    if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) return true;
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return true;
      if (valid[nr * cols + nc] !== 1) return true;
    }
    return false;
  };

  // A binary heap ordered by (elevation, insertion order), matching the one
  // `priorityFlood` uses, so tie-breaking cannot be the source of a mismatch.
  const cell = new Int32Array(n);
  const key = new Float64Array(n);
  const seq = new Int32Array(n);
  let size = 0;
  let counter = 0;
  const less = (a: number, b: number): boolean =>
    key[a] !== key[b] ? key[a] < key[b] : seq[a] < seq[b];
  const swap = (a: number, b: number): void => {
    [cell[a], cell[b]] = [cell[b], cell[a]];
    [key[a], key[b]] = [key[b], key[a]];
    [seq[a], seq[b]] = [seq[b], seq[a]];
  };
  const push = (c: number, k: number): void => {
    let i = size++;
    cell[i] = c; key[i] = k; seq[i] = counter++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(i, parent)) break;
      swap(i, parent);
      i = parent;
    }
  };
  const pop = (): number => {
    const top = cell[0];
    const last = --size;
    cell[0] = cell[last]; key[0] = key[last]; seq[0] = seq[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let small = i;
      if (l < size && less(l, small)) small = l;
      if (r < size && less(r, small)) small = r;
      if (small === i) break;
      swap(i, small);
      i = small;
    }
    return top;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (valid[i] !== 1 || !isEdgeSeed(col, row)) continue;
      closed[i] = 1;
      push(i, z[i]);
    }
  }

  let cellsRaised = 0;
  let maxFillDepth = 0;
  let fillDepthSum = 0;
  let epsilonAbsorbed = 0;

  while (size > 0) {
    const c = pop();
    const zc = z[c];
    const col = c % cols;
    const row = (c - col) / cols;
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nb = nr * cols + nc;
      if (valid[nb] !== 1 || closed[nb] === 1) continue;
      closed[nb] = 1;
      const original = z[nb];
      if (original <= zc) {
        const target = zc + epsilon;
        z[nb] = target;
        const rise = z[nb] - original;
        if (rise > 0) {
          cellsRaised++;
          fillDepthSum += rise;
          if (rise > maxFillDepth) maxFillDepth = rise;
        }
        if (epsilon > 0 && z[nb] <= zc) epsilonAbsorbed++;
      }
      push(nb, z[nb]);
    }
  }

  return { z, cellsRaised, maxFillDepth, fillDepthSum, epsilonAbsorbed };
}

/**
 * Plain queue flood-fill from the boundary, through valid cells only: the
 * `wall` reading's reachable set, computed without the conditioning pass's
 * elevation-ordered heap.
 */
function reachableUnderWall(grid: FlowGrid): Uint8Array {
  const { valid, cols, rows } = grid;
  const n = cols * rows;
  const reached = new Uint8Array(n);
  const queue: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const onBoundary = col === 0 || row === 0 || col === cols - 1 || row === rows - 1;
      const i = row * cols + col;
      if (onBoundary && valid[i] === 1 && reached[i] === 0) {
        reached[i] = 1;
        queue.push(i);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const c = queue[head++];
    const col = c % cols;
    const row = (c - col) / cols;
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nb = nr * cols + nc;
      if (valid[nb] !== 1 || reached[nb] === 1) continue;
      reached[nb] = 1;
      queue.push(nb);
    }
  }
  return reached;
}

const SEEDS = 3000;
const EPSILON = 0.01;

describe('the outlet reading reproduces the seeding this branch replaced', () => {
  it('matches a standalone reimplementation of the old seeding, field for field, over 3,000 random grids', () => {
    const rand = mulberry32(20260922);
    for (let seed = 0; seed < SEEDS; seed++) {
      const cols = 5 + Math.floor(rand() * 10);
      const rows = 5 + Math.floor(rand() * 10);
      const grid = randomGrid(rand, cols, rows, 0.30, 0.75);

      const got = priorityFlood(grid, { epsilon: EPSILON, noData: 'outlet' });
      const want = earlierSeedingFlood(grid, EPSILON);

      expect(got.z, `seed ${seed}: z (${cols}x${rows})`).toEqual(want.z);
      expect(got.cellsRaised, `seed ${seed}: cellsRaised`).toBe(want.cellsRaised);
      expect(got.maxFillDepth, `seed ${seed}: maxFillDepth`).toBe(want.maxFillDepth);
      expect(got.fillDepthSum, `seed ${seed}: fillDepthSum`).toBe(want.fillDepthSum);
      expect(got.epsilonAbsorbed, `seed ${seed}: epsilonAbsorbed`).toBe(want.epsilonAbsorbed);
      expect(got.cellsUnreachable, `seed ${seed}: outlet leaves nothing unreachable`).toBe(0);
    }
  });
});

describe('cellsUnreachable under the wall matches an independent flood-fill', () => {
  it('agrees with a plain breadth-first search from the boundary over 3,000 random grids', () => {
    const rand = mulberry32(870102394);
    for (let seed = 0; seed < SEEDS; seed++) {
      const cols = 5 + Math.floor(rand() * 10);
      const rows = 5 + Math.floor(rand() * 10);
      const grid = randomGrid(rand, cols, rows, 0.30, 0.75);

      const got = priorityFlood(grid, { epsilon: EPSILON, noData: 'wall' });
      const reached = reachableUnderWall(grid);

      let validCount = 0;
      let reachedCount = 0;
      for (let i = 0; i < grid.valid.length; i++) {
        if (grid.valid[i] !== 1) continue;
        validCount++;
        if (reached[i] === 1) reachedCount++;
      }
      expect(got.cellsUnreachable, `seed ${seed}: BFS-reachable disagrees with cellsUnreachable`)
        .toBe(validCount - reachedCount);
    }
  });
});

describe('the wall leaves no sink or flat on any cell it reached', () => {
  it('agrees with D8 on the conditioned surface, restricted to the BFS-reachable set, over 3,000 random grids', () => {
    const rand = mulberry32(55511);
    for (let seed = 0; seed < SEEDS; seed++) {
      const cols = 5 + Math.floor(rand() * 10);
      const rows = 5 + Math.floor(rand() * 10);
      const grid = randomGrid(rand, cols, rows, 0.30, 0.75);

      const conditioned = priorityFlood(grid, { epsilon: EPSILON, noData: 'wall' });
      expect(conditioned.epsilonAbsorbed, `seed ${seed}: epsilon absorbed at this magnitude`).toBe(0);
      const reached = reachableUnderWall(grid);

      const routed = d8Flow({ ...grid, z: conditioned.z });
      for (let i = 0; i < grid.valid.length; i++) {
        if (grid.valid[i] !== 1 || reached[i] !== 1) continue;
        expect(routed.status[i], `seed ${seed}: cell ${i} reached but SINK`).not.toBe(CELL_SINK);
        expect(routed.status[i], `seed ${seed}: cell ${i} reached but FLAT`).not.toBe(CELL_FLAT);
      }
    }
  });
});
