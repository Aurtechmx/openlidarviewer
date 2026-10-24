/**
 * terrainAccessStepRouting.test.ts: the step limit, end to end through
 * `runTerrainAccess`, limits discontinuities and nothing else.
 *
 * Before the step was measured as a discontinuity, a 0.3 m step limit on
 * 2.566 m cells capped every move at a 6.7° grade (4.7° on a diagonal), so a
 * smooth 10° slope was refused under a 20° grade limit and a 6° one was
 * costed as if its slope were a step. And a diagonal move slipped between the
 * two cells of a one-cell berm or ditch of any height with a step of 0 m.
 */
import { describe, expect, it } from 'vitest';

import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { costDriversSentence } from '../src/simulation/terrainAccess/terrainAccessExplain';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { parseTerrainAccessProfileForm, terrainAccessExampleForm } from '../src/ui/fieldSimulation/terrainAccessProfileForm';

const SCALE: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const IDENTITY = {
  layerId: null, filename: null, sourceDigest: null, analysisInputDigest: 'digest',
  build: 'test-build', id: 'run-1', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};
const USER_CELL = 2.5661413613706827;

/** A rise per cell rounded to 1/4096 m, so the plane's heights and their differences are exact in Float32. */
const dyadic = (v: number): number => Math.round(v * 4096) / 4096;
const tanDeg = (deg: number): number => Math.tan((deg * Math.PI) / 180);

function dtm(cols: number, rows: number, cell: number, f: (col: number, row: number) => number): DtmGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = f(c, r);
  return {
    z, confidence: new Float32Array(n).fill(100), coverage: new Uint8Array(n).fill(2),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: cell, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
}

function walker(): TerrainAccessProfile {
  const parsed = parseTerrainAccessProfileForm(terrainAccessExampleForm('walker'));
  if (!parsed.ok) throw new Error('the Walker example did not parse');
  return parsed.profile;
}

/** Generous grade and cross-slope limits and no width, so only the step limit decides. */
function stepOnly(maxStepHeight: number): TerrainAccessProfile {
  return {
    name: 'step only', maxLongitudinalGrade: tanDeg(35), maxCrossSlope: tanDeg(35), maxStepHeight,
    maxRuggedness: null, vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0,
    unknownPolicy: 'block', obstacleHeightThreshold: null,
  };
}

describe('a smooth slope inside the grade limit routes straight up under the Walker example', () => {
  const N = 21;
  for (const cell of [0.5, 1, USER_CELL, 5]) {
    for (const deg of [2, 6, 10, 19]) {
      it(`${deg}° on ${cell} m cells`, () => {
        const rise = dyadic(tanDeg(deg) * cell);
        const r = runTerrainAccess(dtm(N, N, cell, (_c, row) => rise * row), SCALE, walker(),
          1 * N + 10, 19 * N + 10, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
        if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
        expect(r.diagnostics.maxEdgeStepM).toBeLessThan(1e-6);
        // Straight up the fall line: no detour around a step that is not there.
        expect(r.diagnostics.horizontalLengthM).toBeCloseTo(18 * cell, 6);
        expect(Math.atan(r.diagnostics.maxLongitudinalGrade) * 180 / Math.PI).toBeCloseTo(deg, 1);
        const step = r.diagnostics.dominantCostContributors.find((c) => c.term === 'step');
        expect(step?.total).toBeLessThan(1e-9);
        const drivers = costDriversSentence(r.diagnostics.dominantCostContributors);
        expect(drivers).toMatch(/^Cost driven mostly by: grade along the route/);
        expect(drivers).not.toMatch(/step height/);
        expect(r.record.result.constraints).toMatchObject({ stepHeight: 'evaluated' });
      });
    }
  }

  it('the grade limit, not the step limit, refuses a slope steeper than it', () => {
    // 25° under a 20° grade and 15° cross-slope limit: no heading fits.
    const rise = dyadic(tanDeg(25) * USER_CELL);
    const r = runTerrainAccess(dtm(N, N, USER_CELL, (_c, row) => rise * row), SCALE, walker(),
      1 * N + 10, 19 * N + 10, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_ROUTE');
    expect(r.reason).not.toMatch(/step height/);
  });
});

describe('a ledge is a step whatever slope it sits on', () => {
  // A full-width ledge between rows 9 and 10, on 2.566 m cells.
  const N = 21;
  for (const deg of [0, 10]) {
    const rise = dyadic(tanDeg(deg) * USER_CELL);
    const grid = dtm(N, N, USER_CELL, (_c, row) => rise * row + (row >= 10 ? 0.5 : 0));

    it(`0.5 m ledge on a ${deg}° slope is refused under a 0.3 m step limit`, () => {
      const r = runTerrainAccess(grid, SCALE, stepOnly(0.3), 2 * N + 10, 18 * N + 10, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NO_ROUTE');
    });

    it(`0.5 m ledge on a ${deg}° slope is crossed under a 0.6 m step limit, and reported as 0.5 m`, () => {
      const r = runTerrainAccess(grid, SCALE, stepOnly(0.6), 2 * N + 10, 18 * N + 10, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
      if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
      expect(r.diagnostics.maxEdgeStepM).toBeCloseTo(0.5, 6);
    });
  }
});

describe('a diagonal move cannot slip through a one-cell berm or ditch', () => {
  // The berm or ditch runs along col = row, corner to corner, so it splits the
  // grid in two; the start and goal are on opposite sides of it.
  const N = 24;
  const start = 12 * N + 4;
  const goal = 4 * N + 12;
  const cases = [
    { label: '2 m berm, 2.566 m cells', cell: USER_CELL, h: 2 },
    { label: '2 m ditch, 2.566 m cells', cell: USER_CELL, h: -2 },
    { label: '0.5 m berm, 1 m cells', cell: 1, h: 0.5 },
  ];
  for (const { label, cell, h } of cases) {
    const grid = dtm(N, N, cell, (c, r) => (c === r ? h : 0));

    it(`${label}: refused under the Walker example`, () => {
      const r = runTerrainAccess(grid, SCALE, walker(), start, goal, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('NO_ROUTE');
    });

    it(`${label}: crossed with its own height reported once the step limit allows it`, () => {
      const r = runTerrainAccess(grid, SCALE, stepOnly(Math.abs(h) + 0.1), start, goal, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
      if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
      expect(r.diagnostics.maxEdgeStepM).toBeCloseTo(Math.abs(h), 6);
    });
  }
});
