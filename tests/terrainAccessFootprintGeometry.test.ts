/**
 * terrainAccessFootprintGeometry.test.ts: hand-calculated fixtures for the
 * footprint model Terrain Access routes under.
 *
 * Geometry every expectation below is derived from (stated once):
 *
 *   - A cell is the rectangle cellMetresX × cellMetresY around its centre.
 *   - "Unsupported" area = every hard-blocked node cell (NoData, outside the
 *     ROI, low confidence under the block policy, ruggedness, obstruction)
 *     plus everything outside the grid.
 *   - The body is a disc of radius ρ = vehicleWidth / 2 on the route
 *     centreline. Distance from a cell centre to a blocked cell offset
 *     (dc, dr) is hypot(max(|dc|·cx − cx/2, 0), max(|dr|·cy − cy/2, 0)).
 *   - Touching policy: a footprint is refused only when that distance is
 *     strictly less than ρ; a body exactly as wide as a corridor fits.
 *   - The centreline itself never meets unsupported area: a diagonal move is
 *     refused when either orthogonal cell bordering it is unsupported, at any
 *     width, including zero.
 *
 * None of these numbers were produced by running the code under test.
 */
import { describe, expect, it } from 'vitest';

import { aStarTerrain } from '../src/simulation/terrainAccess/aStarTerrain';
import { dilateBlocked } from '../src/simulation/terrainAccess/footprintClearance';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import {
  DEFAULT_COST_WEIGHTS, applyWidthClearance, buildTraversabilityMap, nodeEligibility, prepareTerrainAccessFeatures,
  transitionAllowed, whyNotEligible,
} from '../src/simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid, TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { gridOf, PERMISSIVE } from './helpers/terrainAccessFixtures';

function setup(grid: TerrainAccessGrid, profile: TerrainAccessProfile) {
  const features = prepareTerrainAccessFeatures(grid, profile);
  const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, profile), profile);
  return { features, eligibility };
}

function route(grid: TerrainAccessGrid, profile: TerrainAccessProfile, start: number, end: number) {
  const { features, eligibility } = setup(grid, profile);
  return aStarTerrain(grid, features, eligibility, profile, start, end, DEFAULT_COST_WEIGHTS);
}

const eligibleCells = (grid: TerrainAccessGrid, profile: TerrainAccessProfile): number[] => {
  const { eligibility } = setup(grid, profile);
  const out: number[] = [];
  eligibility.blocked.forEach((b, i) => { if (b === 0) out.push(i); });
  return out;
};

function dtmOf(values: (number | null)[][]): DtmGrid {
  const rows = values.length, cols = values[0].length, n = cols * rows;
  const z = new Float32Array(n), coverage = new Uint8Array(n), confidence = new Float32Array(n);
  values.flat().forEach((v, i) => { if (v !== null) { z[i] = v; coverage[i] = 2; confidence[i] = 100; } });
  return {
    z, coverage, confidence, counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
}
const SCALE = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const IDENTITY = {
  layerId: 'fixture', filename: 'fixture.las', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};

// ── S1: diagonal corner cutting ─────────────────────────────────────────────

describe('diagonal moves never pass the shared corner of unsupported cells', () => {
  // The four orientations of [start, NoData; NoData, goal] on a 2×2 grid.
  const CORNERS: readonly { name: string; z: (number | null)[][]; start: number; end: number }[] = [
    { name: 'SE', z: [[0, null], [null, 0]], start: 0, end: 3 },
    { name: 'NW', z: [[0, null], [null, 0]], start: 3, end: 0 },
    { name: 'SW', z: [[null, 0], [0, null]], start: 1, end: 2 },
    { name: 'NE', z: [[null, 0], [0, null]], start: 2, end: 1 },
  ];

  for (const c of CORNERS) {
    for (const width of [0, 0.2]) {
      it(`${c.name}, width ${width} m: NO_ROUTE`, () => {
        const result = route(gridOf(c.z), { ...PERMISSIVE, vehicleWidth: width }, c.start, c.end);
        expect(result.outcome).toBe('NO_ROUTE');
        expect(result.path).toEqual([]);
      });
    }
  }

  it('the audit case through the full run is refused, not routed as [0, 3]', () => {
    const r = runTerrainAccess(dtmOf([[0, null], [null, 0]]), SCALE,
      { ...PERMISSIVE, vehicleWidth: 0.2 }, 0, 3, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_ROUTE');
  });

  it('one unsupported orthogonal cell forces the two-step orthogonal route (length 2, not √2)', () => {
    // [0, null; 0, 0]: the diagonal 0→3 touches NoData cell 1's corner.
    const result = route(gridOf([[0, null], [0, 0]]), PERMISSIVE, 0, 3);
    expect(result.outcome).toBe('FOUND');
    expect(result.path).toEqual([0, 2, 3]);
    expect(result.cost).toBe(2);
  });

  const blockedBy: readonly { name: string; grid: TerrainAccessGrid; profile: TerrainAccessProfile }[] = [
    {
      name: 'excluded ROI',
      grid: gridOf([[0, 0], [0, 0]], { allowed: new Uint8Array([1, 0, 0, 1]) }),
      profile: PERMISSIVE,
    },
    {
      name: 'low confidence under the block policy',
      grid: { ...gridOf([[0, 0], [0, 0]]), confidence: new Float32Array([100, 10, 10, 100]) },
      profile: { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'block' },
    },
    {
      name: 'obstruction evidence',
      grid: gridOf([[0, 0], [0, 0]], { heightAboveGround: new Float32Array([0, 3, 3, 0]) }),
      profile: { ...PERMISSIVE, obstacleHeightThreshold: 1 },
    },
  ];
  for (const b of blockedBy) {
    it(`diagonal between two cells blocked by ${b.name} is refused`, () => {
      expect(route(b.grid, b.profile, 0, 3).outcome).toBe('NO_ROUTE');
    });
  }

  it('low confidence under the penalize policy is not unsupported, so the diagonal stays open', () => {
    const grid = { ...gridOf([[0, 0], [0, 0]]), confidence: new Float32Array([100, 10, 10, 100]) };
    const result = route(grid, { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'penalize' }, 0, 3);
    expect(result.outcome).toBe('FOUND');
    expect(result.path).toEqual([0, 3]);
  });

  it('open diagonal terrain stays routable at √2 per diagonal on unit cells', () => {
    const grid = gridOf([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    for (const width of [0, 0.2, 1]) {
      const result = route(grid, { ...PERMISSIVE, vehicleWidth: width }, 0, 8);
      expect(result.outcome).toBe('FOUND');
      expect(result.path).toEqual([0, 4, 8]);
      expect(result.cost).toBeCloseTo(2 * Math.SQRT2, 12);
    }
  });

  it('open diagonal on anisotropic cells costs hypot(cx, cy)', () => {
    const grid = gridOf([[0, 0], [0, 0]], { cellMetresX: 2, cellMetresY: 1 });
    const result = route(grid, PERMISSIVE, 0, 3);
    expect(result.path).toEqual([0, 3]);
    expect(result.cost).toBeCloseTo(Math.sqrt(5), 12);
  });

  it('the traversability map and the why-not inspector apply the same edge rule', () => {
    // Cells 0 and 3 are eligible, but their only eligible neighbour is the
    // other one, across the NoData corner: nothing can move through either.
    const grid = gridOf([[0, null], [null, 0]]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const map = buildTraversabilityMap(grid, features, eligibility, PERMISSIVE);
    expect(map[0].state).toBe('blocked');
    expect(map[3].state).toBe('blocked');
    expect(whyNotEligible(grid, features, eligibility, PERMISSIVE, 0).eligible).toBe(false);
  });

  it('positive width: the swept segment is checked, not only its two end discs', () => {
    // 8×8 unit grid, one NoData cell at (row 2, col 5). Move (3,3) → (4,4).
    // Endpoint clearances: (3,3): hypot(2 − ½, 1 − ½) = hypot(1.5, 0.5) ≈ 1.581;
    // (4,4): hypot(1 − ½, 2 − ½) ≈ 1.581. The blocked cell's corner (4.5, 2.5)
    // projects onto the segment's midpoint (3.5, 3.5) at distance √2 ≈ 1.414.
    // Border clearance of both endpoints is ≥ 3.5 m.
    const z: (number | null)[][] = Array.from({ length: 8 }, () => Array(8).fill(0));
    z[2][5] = null;
    const grid = gridOf(z);
    const from = 3 * 8 + 3;
    const check = (width: number, dx: number, dy: number, at: number) => {
      const profile = { ...PERMISSIVE, vehicleWidth: width };
      const { eligibility } = setup(grid, profile);
      return transitionAllowed(grid, eligibility, profile, at, dx, dy);
    };
    // ρ = 1.5: both endpoints clear (1.581 ≥ 1.5), the midpoint does not (1.414 < 1.5).
    const { eligibility: e3 } = setup(grid, { ...PERMISSIVE, vehicleWidth: 3 });
    expect(e3.blocked[from]).toBe(0);
    expect(e3.blocked[4 * 8 + 4]).toBe(0);
    expect(check(3, 1, 1, from)).toBe(false);
    expect(check(3, -1, -1, 4 * 8 + 4)).toBe(false); // the reverse move agrees
    // ρ = 1.4 < √2: the segment clears.
    expect(check(2.8, 1, 1, from)).toBe(true);
    expect(check(2.8, -1, -1, 4 * 8 + 4)).toBe(true);
  });
});

// ── S2: footprint clearance against cell rectangles ─────────────────────────

describe('width clearance measures to the blocked cell rectangle and the survey edge', () => {
  // 3 cols × 5 rows: [NoData, 0, NoData] per row, 1 m cells. The corridor is
  // 1 m wide; each corridor centre is 0.5 m from both NoData rectangles. The
  // top and bottom corridor cells are 0.5 m from the survey edge.
  const corridor = (): TerrainAccessGrid => gridOf(Array.from({ length: 5 }, () => [null, 0, null]));
  const CORRIDOR = [1, 4, 7, 10, 13];

  it('a 1.2 m body is refused in the 1 m corridor (0.5 < 0.6)', () => {
    expect(eligibleCells(corridor(), { ...PERMISSIVE, vehicleWidth: 1.2 })).toEqual([]);
  });

  it('the audit case through the full run is refused, not routed as [4, 7, 10]', () => {
    const r = runTerrainAccess(dtmOf(Array.from({ length: 5 }, () => [null, 0, null])), SCALE,
      { ...PERMISSIVE, vehicleWidth: 1.2 }, 4, 10, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/vehicle width/i);
  });

  it('a 0.8 m body passes the corridor end to end (0.5 ≥ 0.4)', () => {
    const profile = { ...PERMISSIVE, vehicleWidth: 0.8 };
    expect(eligibleCells(corridor(), profile)).toEqual(CORRIDOR);
    const result = route(corridor(), profile, 1, 13);
    expect(result.path).toEqual(CORRIDOR);
    expect(result.cost).toBe(4);
  });

  it('just below, at and just above the corridor width, under the touching policy', () => {
    expect(eligibleCells(corridor(), { ...PERMISSIVE, vehicleWidth: 0.999 })).toEqual(CORRIDOR);
    // ρ = 0.5 = clearance: touching, not overlapping, so it fits.
    expect(eligibleCells(corridor(), { ...PERMISSIVE, vehicleWidth: 1 })).toEqual(CORRIDOR);
    expect(eligibleCells(corridor(), { ...PERMISSIVE, vehicleWidth: 1.001 })).toEqual([]);
  });

  it('anisotropic cells: each axis is measured in its own metres', () => {
    // cx = 2 m, cy = 0.5 m. Corridor width 2 m → wall clearance 1 m. Row
    // centres sit (r + ½)·0.5 m from the top edge: 0.25, 0.75, 1.25, 0.75,
    // 0.25 m to the nearer end. With ρ = 1 only row 2 clears both ends.
    const grid = gridOf(Array.from({ length: 5 }, () => [null, 0, null]), { cellMetresX: 2, cellMetresY: 0.5 });
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 2 })).toEqual([7]);
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 2.1 })).toEqual([]);
    // ρ = 0.25: walls (1 m) and ends (0.25 m, touching) all clear.
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 0.5 })).toEqual(CORRIDOR);
    // ρ = 0.3: the end rows (0.25 m from the edge) no longer fit.
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 0.6 })).toEqual([4, 7, 10]);
  });

  it('survey edges erode the map by the radius', () => {
    // 5×5 fully supported, 1 m. Edge clearance of (r, c) is
    // min(c + ½, 4.5 − c, r + ½, 4.5 − r).
    const grid = gridOf(Array.from({ length: 5 }, () => Array(5).fill(0)));
    const inner3x3 = [6, 7, 8, 11, 12, 13, 16, 17, 18];
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 3 })).toEqual(inner3x3); // ρ 1.5, touching
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 3.2 })).toEqual([12]);
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 5 })).toEqual([12]); // ρ 2.5, touching
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 5.2 })).toEqual([]);
  });

  it('a 100 m footprint on a 5 × 5 m map is refused with a stated reason', () => {
    const r = runTerrainAccess(dtmOf(Array.from({ length: 5 }, () => Array(5).fill(0))), SCALE,
      { ...PERMISSIVE, vehicleWidth: 100 }, 6, 18, TERRAIN_ACCESS_DEFAULTS, IDENTITY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('INSUFFICIENT_EVIDENCE');
    expect(r.reason).toMatch(/vehicle width/i);
    expect(r.reason).toMatch(/100 m/);
  });

  it('a huge width does not scan an unbounded window', () => {
    const blocked = new Uint8Array(400 * 400);
    blocked[200 * 400 + 200] = 1;
    const t0 = performance.now();
    const out = dilateBlocked(blocked, 400, 400, 1, 1, 1e9);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(out.every((v) => v === 1)).toBe(true);
  });

  it('ROI edges erode by the radius', () => {
    // 5×5 supported, ROI = inner 3×3. With ρ = 0.6 every ROI cell beside the
    // excluded ring (0.5 m away) is refused; the centre is 1.5 m away.
    const allowed = new Uint8Array(25);
    for (const i of [6, 7, 8, 11, 12, 13, 16, 17, 18]) allowed[i] = 1;
    const grid = gridOf(Array.from({ length: 5 }, () => Array(5).fill(0)), { allowed });
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 1.2 })).toEqual([12]);
    expect(eligibleCells(grid, { ...PERMISSIVE, vehicleWidth: 0.8 })).toEqual([6, 7, 8, 11, 12, 13, 16, 17, 18]);
  });

  it('holes: orthogonal neighbours at 0.5 m, diagonal neighbours at √0.5 m', () => {
    // 5×5, NoData at the centre, ρ = 0.6. Orthogonal neighbours (0.5) and the
    // whole outer ring (0.5 m from the edge) are refused; the four diagonal
    // neighbours (hypot(0.5, 0.5) ≈ 0.707) remain.
    const z: (number | null)[][] = Array.from({ length: 5 }, () => Array(5).fill(0));
    z[2][2] = null;
    expect(eligibleCells(gridOf(z), { ...PERMISSIVE, vehicleWidth: 1.2 })).toEqual([6, 8, 16, 18]);
    // ρ = 0.75 > 0.707: none remain.
    expect(eligibleCells(gridOf(z), { ...PERMISSIVE, vehicleWidth: 1.5 })).toEqual([]);
  });

  it('dilateBlocked on its own: rectangle distance, virtual border, input untouched', () => {
    // 7×7 unit grid, centre blocked, ρ = 1: orthogonal (0.5) and diagonal
    // (0.707) neighbours refused; two cells out orthogonally (1.5) kept; the
    // outer ring (0.5 from the edge) refused.
    const blocked = new Uint8Array(49);
    blocked[24] = 1;
    const out = dilateBlocked(blocked, 7, 7, 1, 1, 2);
    const kept: number[] = [];
    out.forEach((v, i) => { if (v === 0) kept.push(i); });
    // Inner 5×5 is rows/cols 1..5; minus the 3×3 around the centre.
    expect(kept).toEqual([8, 9, 10, 11, 12, 15, 19, 22, 26, 29, 33, 36, 37, 38, 39, 40]);
    expect(blocked.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
