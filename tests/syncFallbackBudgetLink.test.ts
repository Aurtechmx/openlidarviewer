/**
 * syncFallbackBudgetLink.test.ts: the shipped fallback ceilings must be the
 * MEASURED ones.
 *
 * Both worker bridges bound their synchronous main-thread fallback by a number
 * that came out of a benchmark ladder, frozen in
 * docs/validation/sync-fallback-budget-baseline.json. Nothing else stops those
 * constants from drifting back to a guess, so this holds each default to the
 * frozen figure and re-derives the figure from the recorded rows: a limit is
 * only valid if the row at it is inside the budget and the next row up is not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MAX_FALLBACK_POINTS as TERRAIN_MAX_POINTS,
  MAX_FALLBACK_CELLS as TERRAIN_MAX_CELLS,
} from '../src/terrain/worker/computeTerrainCoreAsync';
import { MAX_FALLBACK_POINTS as CLASSIFY_MAX_POINTS } from '../src/render/class/deriveClassificationAsync';

interface Row {
  points: number;
  cells?: number;
  ms: number;
}
interface Baseline {
  budgetMs: number;
  rows: {
    terrainPoints: Row[];
    terrainCells: Row[];
    terrainCorners: Row[];
    classifyPoints: Row[];
  };
  limits: Record<string, { value: number; basis: string }>;
}

const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../docs/validation/sync-fallback-budget-baseline.json', import.meta.url)),
    'utf8',
  ),
) as Baseline;

describe('synchronous fallback ceilings are the measured ones', () => {
  it('ships the terrain point limit the baseline froze', () => {
    expect(TERRAIN_MAX_POINTS).toBe(baseline.limits.terrainMaxFallbackPoints.value);
  });

  it('ships the terrain cell limit the baseline froze', () => {
    expect(TERRAIN_MAX_CELLS).toBe(baseline.limits.terrainMaxFallbackCells.value);
  });

  it('ships the classifier point limit the baseline froze', () => {
    expect(CLASSIFY_MAX_POINTS).toBe(baseline.limits.classifyMaxFallbackPoints.value);
  });

  it('the terrain limits sit at a corner that measured inside the budget', () => {
    const corner = baseline.rows.terrainCorners.find((r) => r.points === TERRAIN_MAX_POINTS);
    expect(corner, 'a corner row was measured at the shipped point limit').toBeDefined();
    expect((corner as Row).cells).toBeGreaterThan(TERRAIN_MAX_CELLS);
    expect((corner as Row).ms).toBeLessThanOrEqual(baseline.budgetMs);
    // Every corner above the shipped limit measured outside the budget, which
    // is what makes this the limit rather than an arbitrary round number.
    for (const row of baseline.rows.terrainCorners) {
      if (row.points > TERRAIN_MAX_POINTS) expect(row.ms).toBeGreaterThan(baseline.budgetMs);
    }
  });

  it('the classifier limit is the last measured row inside the budget', () => {
    const rows = [...baseline.rows.classifyPoints].sort((a, b) => a.points - b.points);
    const inside = rows.filter((r) => r.ms <= baseline.budgetMs);
    expect(inside.at(-1)?.points).toBe(CLASSIFY_MAX_POINTS);
    const next = rows.find((r) => r.points > CLASSIFY_MAX_POINTS);
    expect(next, 'a row above the limit was measured').toBeDefined();
    expect((next as Row).ms).toBeGreaterThan(baseline.budgetMs);
  });

  it('every recorded row carries a real measurement', () => {
    const all = [
      ...baseline.rows.terrainPoints,
      ...baseline.rows.terrainCells,
      ...baseline.rows.terrainCorners,
      ...baseline.rows.classifyPoints,
    ];
    expect(all.length).toBeGreaterThan(15);
    for (const row of all) {
      expect(Number.isFinite(row.ms) && row.ms > 0).toBe(true);
      expect(Number.isFinite(row.points) && row.points > 0).toBe(true);
    }
  });
});
