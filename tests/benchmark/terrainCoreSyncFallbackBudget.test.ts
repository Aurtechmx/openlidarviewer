/**
 * terrainCoreSyncFallbackBudget.test.ts: how much terrain work the synchronous
 * main-thread fallback may do before it stops being a recovery and becomes a
 * freeze.
 *
 * `computeTerrainCoreAsync` runs `computeTerrainCore` on the main thread when
 * the terrain worker fails. That path has to be bounded by a measured number,
 * not a guess, so this records three ladders:
 *
 *   A. POINTS. A point ladder at a fixed 625-cell grid (1000 m span, 40 m
 *      cell), so the grid term is held still and the point term is what moves.
 *   B. CELLS. A fixed 2 000-point cloud rasterised at several cell sizes, so
 *      the grid term is what moves. Cost rises with cells far faster than with
 *      points, because a sparse grid spends its time filling voids, so a point
 *      bound alone would let a fine cell size walk past the budget.
 *   C. CORNER. The two limits together, which is the case the guard actually
 *      has to keep inside the budget.
 *
 * The budget is 200 ms: long enough to be worth attempting, short enough that a
 * user who triggers the fallback sees a hitch rather than a hang.
 *
 * Node timings are a PROXY for the browser main thread, not the same number.
 * Node and a browser tab run the same V8 on different heaps and under different
 * scheduling, so read the crossing point as an order of magnitude, not a
 * guarantee.
 *
 * Off by default (it computes many cores). Run it with
 * `SYNC_FALLBACK_BENCH=1 npx vitest run tests/benchmark/terrainCoreSyncFallbackBudget.test.ts`.
 * The frozen rows live in docs/validation/sync-fallback-budget-baseline.json,
 * and tests/syncFallbackBudgetLink.test.ts holds the shipped defaults to them.
 */
import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { computeTerrainCore } from '../../src/terrain/contour/analyseContours';
import type { TerrainCoreParams } from '../../src/terrain/contour/analyseContours';
import { makeTerrainBenchCloud } from '../helpers/terrainBenchCloud';

const ENABLED = process.env.SYNC_FALLBACK_BENCH === '1';

/** The main-thread stall a fallback is allowed to cost, in milliseconds. */
const BUDGET_MS = 200;

/** The extent the bench cloud spans, in metres (see makeTerrainBenchCloud). */
const SPAN_M = 1000;

/** Ladder A: points, at a fixed 40 m cell (625 cells). */
const POINT_LADDER = [2_000, 10_000, 50_000, 100_000, 200_000, 500_000];
const POINT_LADDER_CELL_M = 40;

/** Ladder B: cell sizes, at a fixed 2 000-point cloud. */
const CELL_SIZE_LADDER = [50, 40, 32, 25];
const CELL_LADDER_POINTS = 2_000;

/** Ladder C: candidate limit pairs, as (points, cellSizeM). */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [25_000, 32],
  [50_000, 32],
  [100_000, 32],
];

const paramsFor = (cellSizeM: number): TerrainCoreParams => ({
  cellSizeM,
  crs: 'EPSG:32610',
  verticalUnitToMetres: 1,
  horizontalUnitToMetres: 1,
});

/** Best-of-N wall time in ms. */
function bestOf(runs: number, body: () => void): number {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    body();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const cellsFor = (cellSizeM: number): number => Math.ceil(SPAN_M / cellSizeM) ** 2;
const pad = (s: string | number, w: number): string => String(s).padStart(w);
// vitest buffers console.log away for a passing test, so write straight to stdout.
const print = (line: string): void => void process.stdout.write(line + '\n');

function row(n: number, cellSizeM: number): void {
  const cloud = makeTerrainBenchCloud(n);
  const params = paramsFor(cellSizeM);
  const ms = bestOf(3, () => {
    computeTerrainCore(cloud, params);
  });
  print(
    '  ' +
      [pad(n, 8), pad(cellSizeM, 10), pad(cellsFor(cellSizeM), 9), pad(ms.toFixed(1), 9)].join(
        ' | ',
      ),
  );
  expect(Number.isFinite(ms)).toBe(true);
}

describe.skipIf(!ENABLED)('synchronous terrain fallback budget', () => {
  it(
    'records where the main-thread terrain core crosses the budget',
    () => {
      print(`\nterrain sync-fallback ladder, budget ${BUDGET_MS} ms, best-of-3`);
      print(
        '  ' + [pad('points', 8), pad('cellSizeM', 10), pad('cells', 9), pad('ms', 9)].join(' | '),
      );
      print('  -- A: points, 625 cells');
      for (const n of POINT_LADDER) row(n, POINT_LADDER_CELL_M);
      print('  -- B: cells, 2 000 points');
      for (const cellSizeM of CELL_SIZE_LADDER) row(CELL_LADDER_POINTS, cellSizeM);
      print('  -- C: candidate limit corners');
      for (const [n, cellSizeM] of CORNERS) row(n, cellSizeM);
    },
    900_000,
  );
});
