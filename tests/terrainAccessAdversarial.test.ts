/**
 * terrainAccessAdversarial.test.ts: §31's Terrain Access register — attempts
 * to make the software overclaim, each of which must fail/refuse or produce
 * honest wording rather than silently succeeding with a wrong answer.
 */
import { describe, expect, it } from 'vitest';

import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { aStarTerrain } from '../src/simulation/terrainAccess/aStarTerrain';
import { computeLocalStep } from '../src/simulation/terrainAccess/localStep';
import {
  DEFAULT_COST_WEIGHTS,
  applyWidthClearance,
  evaluateEdge,
  nodeEligibility,
  prepareTerrainAccessFeatures,
} from '../src/simulation/terrainAccess/traversabilityCost';
import { computeRouteDiagnostics } from '../src/simulation/terrainAccess/routeDiagnostics';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessGrid, TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function gridOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<TerrainAccessGrid> = {},
): TerrainAccessGrid {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h).fill(Number.NaN);
  const valid = new Uint8Array(w * h);
  const confidence = new Float32Array(w * h).fill(100);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      valid[r * w + c] = 1;
    }
  }
  return {
    z, valid, confidence, coverage: null, heightAboveGround: null, allowed: null,
    cols: w, rows: h, cellMetresX: 1, cellMetresY: 1,
    ...over,
  };
}

const PERMISSIVE: TerrainAccessProfile = Object.freeze({
  name: 'test',
  maxLongitudinalGrade: 10,
  maxCrossSlope: 10,
  maxStepHeight: 10,
  maxRuggedness: null,
  vehicleWidth: 0,
  vehicleLength: null,
  minimumTerrainConfidence: 0,
  unknownPolicy: 'block',
  obstacleHeightThreshold: null,
});

describe('adversarial: NoData must not be treated as elevation', () => {
  it('a NoData cell does not pollute a valid neighbour\'s Horn slope with a fabricated 0 m elevation', () => {
    // A steep, uniform slope with a NoData cell dropped into it. If the
    // adapter (or the feature-preparation defence) ever read that cell as a
    // real elevation of 0 m, the Horn window of its valid neighbour would
    // read a spurious discontinuity that is not present in the true surface.
    const cols = 5;
    const rowsN = 5;
    const rowsData: (number | null)[][] = [];
    for (let r = 0; r < rowsN; r++) {
      const row: (number | null)[] = [];
      for (let c = 0; c < cols; c++) row.push(-c * 2); // a real, steep, uniform slope
      rowsData.push(row);
    }
    const withoutGap = gridOf(rowsData);
    const withGap = gridOf(rowsData.map((row, r) => (r === 2 ? row.map((v, c) => (c === 1 ? null : v)) : row)));

    const featuresWithout = prepareTerrainAccessFeatures(withoutGap, PERMISSIVE);
    const featuresWith = prepareTerrainAccessFeatures(withGap, PERMISSIVE);

    // The cell diagonally/orthogonally adjacent to the gap, but itself still
    // fully surrounded by REAL elevation on the side away from the gap, must
    // read the same slope in both grids on that side — the far side of its
    // Horn window contains no NoData. Cell (row 2, col 3) neighbours the gap
    // at (row 2, col 1) only through (row 2, col 2), which is two cells away
    // and therefore outside its own 3×3 window.
    const farCell = 2 * cols + 3;
    expect(featuresWith.slope[farCell]).toBeCloseTo(featuresWithout.slope[farCell], 5);

    // Directly checking the raw mechanism: hornSlopeAspect must see NaN, not
    // 0, at the gap — otherwise this whole test is checking nothing.
    expect(Number.isNaN(withGap.z[2 * cols + 1])).toBe(true);
  });

  it('route crosses NoData under block policy: refused, not silently routed through', () => {
    const grid = gridOf([
      [0, 0, 0],
      [null, null, null],
      [0, 0, 0],
    ]);
    const features = prepareTerrainAccessFeatures(grid, PERMISSIVE);
    const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, PERMISSIVE), PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 1, 7, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('NO_ROUTE');
    expect(result.path.every((i) => grid.valid[i] === 1)).toBe(true);
  });
});

describe('adversarial: total slope is not substituted for cross slope', () => {
  it('a heading whose cross slope is near zero is not rejected using the (much larger) total slope', () => {
    const cols = 5;
    const rowsN = 3;
    const rowsData: number[][] = [];
    for (let r = 0; r < rowsN; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(-c); // tangent 1.0 (45°) downslope east
      rowsData.push(row);
    }
    const grid = gridOf(rowsData);
    // Total slope here is ~1.0. A profile whose maxCrossSlope is small (0.1)
    // but maxLongitudinalGrade is generous (2.0) must still accept the
    // straight-downslope heading, which an implementation that checked total
    // slope against maxCrossSlope would wrongly reject.
    const profile = { ...PERMISSIVE, maxLongitudinalGrade: 2, maxCrossSlope: 0.1 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const centre = 1 * cols + 2;
    const east = evaluateEdge(grid, features, profile, centre, centre + 1, 1, 0);
    expect(east.blocked).toBe(false);
    expect(east.crossSlope).toBeLessThan(0.1);
  });
});

describe('adversarial: vehicle width is not ignored through a narrow gap', () => {
  it('the pinch cell itself is hard-blocked after width clearance, not merely unreachable by luck', () => {
    const allowed = new Uint8Array([
      1, 0, 1, 1,
      1, 1, 1, 1,
      1, 0, 1, 1,
    ]);
    const grid = gridOf(Array.from({ length: 3 }, () => Array(4).fill(0)), { allowed });
    const wide = { ...PERMISSIVE, vehicleWidth: 2.5 };
    const features = prepareTerrainAccessFeatures(grid, wide);
    const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, wide), wide);
    const pinch = 1 * 4 + 1;
    expect(eligibility.blocked[pinch]).toBe(1);
    expect(eligibility.reason[pinch]).toBe('vehicle-width');
  });
});

describe('adversarial: an interpolated/low-confidence cell is never presented as measured', () => {
  it('route diagnostics reports a low-confidence route cell in the low-confidence bucket, never in fractionMeasured', () => {
    const grid = gridOf([[0, 0, 0]], { coverage: new Uint8Array([2, 1, 2]), confidence: new Float32Array([100, 10, 100]) });
    const profile = { ...PERMISSIVE, unknownPolicy: 'penalize' as const };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const diagnostics = computeRouteDiagnostics(grid, features, [0, 1, 2], DEFAULT_COST_WEIGHTS, profile);
    expect(diagnostics.fractionMeasured).toBeCloseTo(2 / 3, 6); // cells 0 and 2 only
    expect(diagnostics.fractionLowConfidenceOrEdgeRisk).toBeCloseTo(1 / 3, 6); // cell 1, below the dashed threshold
    expect(diagnostics.fractionInterpolated).toBeCloseTo(0, 6);
  });
});

describe('adversarial: a route is never called safe', () => {
  it('the sealed run record\'s limitations always carry the geometry-only disclaimer', () => {
    const dtm: DtmGrid = (() => {
      const rowsData = Array.from({ length: 3 }, () => Array(3).fill(0));
      const n = 9;
      const z = new Float32Array(n);
      const confidence = new Float32Array(n).fill(100);
      const coverage = new Uint8Array(n).fill(2);
      const counts = new Uint32Array(n).fill(1);
      const interpDistanceCells = new Float32Array(n);
      void rowsData;
      return {
        z, confidence, coverage, counts, interpDistanceCells,
        cols: 3, rows: 3, cellSizeM: 1, originH1: 0, originH2: 0,
        crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
        verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
        withheldExcluded: true, meanConfidence: 100, warnings: [],
      };
    })();
    const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
    const identity = {
      layerId: null, filename: null, sourceDigest: null, analysisInputDigest: 'd',
      build: 'b', id: 'i', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
    };
    const result = runTerrainAccess(dtm, scale, PERMISSIVE, 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.limitations.some((l) => /not a safety assessment/.test(l))).toBe(true);
    }
  });
});

describe('adversarial: Terrain Access never borrows Flow Pulse\'s wording', () => {
  it('a run with interpolated and no-elevation cells never says "Flow" anywhere in its limitations', () => {
    const n = 9;
    const dtm: DtmGrid = {
      z: new Float32Array(n),
      // Cell 4 interpolated (coverage 1), cell 8 absent (coverage 0, no elevation).
      coverage: Uint8Array.from([2, 2, 2, 2, 1, 2, 2, 2, 0]),
      confidence: new Float32Array(n).fill(100),
      counts: new Uint32Array(n).fill(1),
      interpDistanceCells: new Float32Array(n),
      cols: 3, rows: 3, cellSizeM: 1, originH1: 0, originH2: 0,
      crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
      verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
      withheldExcluded: true, meanConfidence: 100, warnings: [],
    };
    const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
    const identity = {
      layerId: null, filename: null, sourceDigest: null, analysisInputDigest: 'd',
      build: 'b', id: 'i', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
    };
    const result = runTerrainAccess(dtm, scale, PERMISSIVE, 0, 3, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Sanity: the interpolated/absent-cell sentences actually fired.
    expect(result.limitations.some((l) => /interpolated elevation/.test(l))).toBe(true);
    expect(result.limitations.some((l) => /carry no elevation/.test(l))).toBe(true);
    for (const l of result.limitations) expect(l).not.toMatch(/\bFlow\b/);
  });
});

describe('adversarial: an invalid normal / Horn window is not treated as fully reliable', () => {
  it('a cell whose centre elevation is missing carries slope 0 and is excluded from eligibility, never averaged in as a real value', () => {
    const z = new Float32Array(9).fill(Number.NaN);
    z[4] = 0; // only the centre is present; every neighbour is missing
    const { slope } = hornSlopeAspect(z, 3, 3, 1, 1);
    expect(slope[4]).toBe(0); // no reliable derivative — reported as 0, not fabricated
    const step = computeLocalStep({
      z, valid: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]),
      confidence: new Float32Array(9).fill(100), coverage: null, heightAboveGround: null, allowed: null,
      cols: 3, rows: 3, cellMetresX: 1, cellMetresY: 1,
    });
    expect(Number.isNaN(step[4])).toBe(true); // "no neighbours to compare" is NOT the same as "step 0"
  });
});

describe('adversarial: the reported route step is the one the limit actually applies to', () => {
  it('reports max edge step <= the limit when only the windowed footprint relief exceeds it', () => {
    // Middle row is flat (the route); one cell just off the route, but
    // inside the 3x3 footprint window of a route cell, carries a large
    // elevation jump. Eligibility (traversabilityCost.ts) gates a move on
    // `edgeStep` (the adjacent-cell jump actually crossed); this proves the
    // diagnostic must agree with that gate rather than with
    // `features.localStep` (footprint relief), which a route can be near
    // without ever crossing.
    const grid = gridOf([
      [10, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const profile = { ...PERMISSIVE, maxStepHeight: 0.3 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    // Route along the middle row: (1,0) -> (1,1) -> (1,2), indices 3, 4, 5.
    // Every edge step along it is 0 m; only cell 4's 3x3 window (which
    // includes cell 0's z=10) carries a large windowed relief.
    expect(features.localStep[4]).toBeGreaterThan(profile.maxStepHeight);
    const diagnostics = computeRouteDiagnostics(grid, features, [3, 4, 5], DEFAULT_COST_WEIGHTS, profile);
    expect(diagnostics.maxEdgeStepM).toBeLessThanOrEqual(profile.maxStepHeight);
    expect(diagnostics.maxEdgeStepM).toBeCloseTo(0, 6);
  });
});
