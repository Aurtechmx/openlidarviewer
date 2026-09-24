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
 * A frontier cell waiting to be resolved: its grid index, the elevation it
 * was queued at, and the order it joined in (the tie-break).
 */
interface PendingCell { at: number; elevation: number; joinedAt: number }

/**
 * Priority order for the frontier below: lowest elevation first, and among
 * equal elevations whichever joined earliest. Deliberately NOT a binary
 * heap — a plain "scan for the best candidate" queue, so this stands as its
 * own implementation rather than a relabelled copy of the module under test.
 */
function isBetterCandidate(a: PendingCell, b: PendingCell): boolean {
  if (a.elevation !== b.elevation) return a.elevation < b.elevation;
  return a.joinedAt < b.joinedAt;
}

/** Pull the best-ranked entry out of `frontier` and return it. */
function takeBestCandidate(frontier: PendingCell[]): PendingCell {
  let bestIndex = 0;
  for (let i = 1; i < frontier.length; i++) {
    if (isBetterCandidate(frontier[i], frontier[bestIndex])) bestIndex = i;
  }
  const [best] = frontier.splice(bestIndex, 1);
  return best;
}

/**
 * The seeding `priorityFlood` used before this branch: every boundary cell
 * and every cell touching NoData is a seed, unconditionally. Reimplemented
 * standalone, from the pre-fix source, rather than imported, so this check
 * does not exercise the same `noData` branch it is meant to verify against.
 * The resolution order (lowest elevation first, ties broken by join order)
 * matches the module under test, but is reached here via a scanned frontier
 * list rather than its binary heap — an independent walk to the same order.
 */
function earlierSeedingFlood(grid: FlowGrid, epsilon: number): {
  z: Float32Array;
  cellsRaised: number;
  maxFillDepth: number;
  fillDepthSum: number;
  epsilonAbsorbed: number;
} {
  const { z: source, valid, cols, rows } = grid;
  const total = cols * rows;
  const z = new Float32Array(source);
  const resolved = new Uint8Array(total);

  const touchesGapOrEdge = (col: number, row: number): boolean => {
    if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) return true;
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) return true;
      if (valid[nr * cols + nc] !== 1) return true;
    }
    return false;
  };

  const frontier: PendingCell[] = [];
  let joinCounter = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const at = row * cols + col;
      if (valid[at] !== 1 || !touchesGapOrEdge(col, row)) continue;
      resolved[at] = 1;
      frontier.push({ at, elevation: z[at], joinedAt: joinCounter++ });
    }
  }

  let cellsRaised = 0;
  let maxFillDepth = 0;
  let fillDepthSum = 0;
  let epsilonAbsorbed = 0;

  while (frontier.length > 0) {
    const current = takeBestCandidate(frontier);
    const fromElevation = z[current.at];
    const col = current.at % cols;
    const row = (current.at - col) / cols;
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const neighbourAt = nr * cols + nc;
      if (valid[neighbourAt] !== 1 || resolved[neighbourAt] === 1) continue;
      resolved[neighbourAt] = 1;
      const before = z[neighbourAt];
      if (before <= fromElevation) {
        const raisedTo = fromElevation + epsilon;
        z[neighbourAt] = raisedTo;
        const rise = z[neighbourAt] - before;
        if (rise > 0) {
          cellsRaised++;
          fillDepthSum += rise;
          if (rise > maxFillDepth) maxFillDepth = rise;
        }
        if (epsilon > 0 && z[neighbourAt] <= fromElevation) epsilonAbsorbed++;
      }
      frontier.push({ at: neighbourAt, elevation: z[neighbourAt], joinedAt: joinCounter++ });
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
