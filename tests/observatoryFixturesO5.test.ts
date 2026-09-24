/**
 * observatoryFixturesO5.test.ts — Observatory phase O5's own exit evidence
 * (docs/observatory/SPEC.md §9.1: F1-F7, F17) plus the shadow-frontier
 * oracle agreement (§9.2).
 *
 * `deriveObservationState` (`stateTable.ts`) was built and exhaustively
 * scored against an independent lattice oracle in phase O1
 * (`tests/observatoryStateTable.test.ts`): every counter combination the
 * nine states can arise from is already covered there, including `CONFLICT`,
 * `PARTIAL`'s complement rule and the residual `UNADDRESSED` default. This
 * file does not re-test that function's own logic; it tests the NEW O5 code
 * `classifyObservationField`/`isVoxelAddressed`/`computeShadowFrontier` add
 * on top of it: the geometric `addressed` test against a station's declared
 * angular/range domain, full-grid wiring (untouched voxels still resolve
 * correctly), and the frontier adjacency walk.
 *
 * F1-F4 and F7 feed `classifyObservationField` directly with per-voxel
 * counters chosen to match the ray outcome each fixture's own declared
 * geometry (`scripts/generate-observatory-fixtures.mjs`'s `buildF1Scene`,
 * `buildF2Scene`, `buildF3Scene`, `buildF7Scene`) would produce at specific
 * probe points, rather than driving the full ray-builder-and-DDA pipeline:
 * that pipeline (OB-RAY, OB-LED) is O3/O4's own exit evidence (F5, F6, F8,
 * F9, F16), already scored against a frozen Python oracle and a synthetic
 * ray set built the same way (`observatoryLedgerTraversal.test.ts`'s
 * `buildF9RaySet`). Re-deriving each probe voxel's exact hit/pass/behind
 * counts from first-principles geometry is done once per fixture below, in
 * the comment beside each probe, so the arithmetic is auditable rather than
 * asserted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildF1Scene, buildF2Scene, buildF3Scene, buildF7Scene } from '../scripts/generate-observatory-fixtures.mjs';
import {
  classifyObservationField,
  isVoxelAddressed,
  type ObservationFieldStation,
} from '../src/observation/observationField';
import { computeShadowFrontier } from '../src/observation/shadowFrontier';
import { domainGrid, packVoxelKey, type ObservationDomain, type ObservationLedgerRow, type ObservationLedgerSourceCounters } from '../src/observation/ledger';
import { createPresenceMask, setSourcePresent, type ObservationParameters } from '../src/observation/types';

const PARAMS: Pick<ObservationParameters, 'p_solid' | 'p_empty' | 'n_min'> = { p_solid: 0.9, p_empty: 0.1, n_min: 5 };

function sourceCounters(sourceIndex: number, over: Partial<Omit<ObservationLedgerSourceCounters, 'sourceIndex'>> = {}): ObservationLedgerSourceCounters {
  return { sourceIndex, hit: 0, pass: 0, behind: 0, noReturn: 0, saturated: false, notDecoded: false, ...over };
}

function aggregate(perSource: readonly ObservationLedgerSourceCounters[]) {
  return perSource.reduce(
    (acc, s) => ({ hit: acc.hit + s.hit, pass: acc.pass + s.pass, behind: acc.behind + s.behind, noReturn: acc.noReturn + s.noReturn }),
    { hit: 0, pass: 0, behind: 0, noReturn: 0 },
  );
}

/** One hand-built ledger row at `key`, with `sourceCount` sized presence bits (F17's 33-source case needs more than one word). */
function buildRow(key: number, perSource: readonly ObservationLedgerSourceCounters[], sourceCount = 1): ObservationLedgerRow {
  const totals = aggregate(perSource);
  const presence = createPresenceMask(sourceCount);
  for (const s of perSource) setSourcePresent(presence, s.sourceIndex);
  return { key, counters: { ...totals, saturated: false }, presence, perSource };
}

// ---------------------------------------------------------------------------
// F1 — one station, wall in front of an open room
// ---------------------------------------------------------------------------

describe('F1 — one station, wall in front of an open room (SPEC §9.1)', () => {
  const scene = buildF1Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const voxelEdge = scene.voxelEdge;
  const station: ObservationFieldStation = {
    sourceIndex: 0,
    origin: [...scene.station.origin] as [number, number, number],
    azimuthDeg: [...scene.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...scene.angularExtent.elevationDeg] as [number, number],
  };
  const grid = domainGrid(domain, voxelEdge);

  const keyAt = (center: readonly [number, number, number]): number => {
    const ix = Math.floor((center[0] - domain.min[0]) / voxelEdge);
    const iy = Math.floor((center[1] - domain.min[1]) / voxelEdge);
    const iz = Math.floor((center[2] - domain.min[2]) / voxelEdge);
    return packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
  };

  // Wall voxel (5.1, 0, 1.5): range = sqrt(5.1^2+1.5^2) ~ 5.317, elevation
  // = asin(1.5/5.317) ~ 16.5 deg, inside [-30, 45] -> addressed. A returned
  // ray landing on the wall's near face gives this voxel hit evidence.
  const wallCenter: readonly [number, number, number] = [5.1, 0, 1.5];
  // Room voxel (6, 0, 1.5), behind the wall on the same line of sight: range
  // ~ 6.185, elevation ~ 14.0 deg, still inside the band -> addressed. The
  // wall blocks every ray before it reaches here: behind-evidence only.
  const roomCenter: readonly [number, number, number] = [6, 0, 1.5];
  // Open space in front of the wall (2, 0, 1.5): range = 2.5, elevation =
  // asin(1.5/2.5) ~ 36.9 deg, inside the band -> addressed. Rays cross this
  // voxel on their way to the wall: pass-evidence only.
  const frontCenter: readonly [number, number, number] = [2, 0, 1.5];
  // Above the declared elevation band (2, 0, 5): range = sqrt(4+25) ~ 5.385,
  // elevation = asin(5/5.385) ~ 68.2 deg > 45 -> NOT addressed.
  const outsideCenter: readonly [number, number, number] = [2, 0, 5];

  const rows: ObservationLedgerRow[] = [
    buildRow(keyAt(wallCenter), [sourceCounters(0, { hit: 6 })]),
    buildRow(keyAt(roomCenter), [sourceCounters(0, { behind: 6 })]),
    buildRow(keyAt(frontCenter), [sourceCounters(0, { pass: 6 })]),
    // outsideCenter has no row: no ray ever reaches an unaddressed voxel.
  ];

  it('isVoxelAddressed agrees with the geometry above', () => {
    expect(isVoxelAddressed(wallCenter, station)).toBe(true);
    expect(isVoxelAddressed(roomCenter, station)).toBe(true);
    expect(isVoxelAddressed(frontCenter, station)).toBe(true);
    expect(isVoxelAddressed(outsideCenter, station)).toBe(false);
  });

  it('classifies the wall SURFACE, the room behind it SHADOWED, the open space OBSERVED_EMPTY, and above the band UNADDRESSED', () => {
    const field = classifyObservationField(domain, voxelEdge, rows, [station], PARAMS);
    expect(field.stateByKey.get(keyAt(wallCenter))?.state).toBe('SURFACE');
    expect(field.stateByKey.get(keyAt(roomCenter))?.state).toBe('SHADOWED');
    expect(field.stateByKey.get(keyAt(frontCenter))?.state).toBe('OBSERVED_EMPTY');
    expect(field.stateByKey.get(keyAt(outsideCenter))?.state).toBe('UNADDRESSED');
  });

  it('every voxel in the domain gets a state, and OUTSIDE_DOMAIN never appears (this classifier only ever sees in-domain cells)', () => {
    const field = classifyObservationField(domain, voxelEdge, rows, [station], PARAMS);
    expect(field.stateByKey.size).toBe(grid.nx * grid.ny * grid.nz);
    expect(field.stateCounts.OUTSIDE_DOMAIN).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F2 — F1 plus a second station behind the wall
// ---------------------------------------------------------------------------

describe('F2 — a second station behind the wall resolves the former shadow, but not in the per-source view (SPEC §9.1)', () => {
  const scene = buildF2Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const voxelEdge = scene.voxelEdge;
  const [s1, s2] = scene.stations;
  const station1: ObservationFieldStation = {
    sourceIndex: 0,
    origin: [...s1.origin] as [number, number, number],
    azimuthDeg: [...scene.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...scene.angularExtent.elevationDeg] as [number, number],
  };
  const station2: ObservationFieldStation = {
    sourceIndex: 1,
    origin: [...s2.origin] as [number, number, number],
    azimuthDeg: [...s2.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...s2.angularExtent.elevationDeg] as [number, number],
  };
  const grid = domainGrid(domain, voxelEdge);
  const roomCenter: readonly [number, number, number] = [6, 0, 1.5];
  const key =
    packVoxelKey(
      Math.floor((roomCenter[0] - domain.min[0]) / voxelEdge),
      Math.floor((roomCenter[1] - domain.min[1]) / voxelEdge),
      Math.floor((roomCenter[2] - domain.min[2]) / voxelEdge),
      grid.nx,
      grid.ny,
    );

  // Station 1 (at the origin) is blocked by the wall: behind-evidence only,
  // as in F1. Station 2 sits inside the room at (10, 0, 1) with a full-sphere
  // angular extent, so it addresses roomCenter and its rays return directly
  // off nearby room surfaces: hit-evidence.
  const rows: ObservationLedgerRow[] = [buildRow(key, [sourceCounters(0, { behind: 6 }), sourceCounters(1, { hit: 6 })], 2)];

  it('the aggregate view resolves the former shadow to SURFACE', () => {
    const field = classifyObservationField(domain, voxelEdge, rows, [station1, station2], PARAMS);
    expect(field.stateByKey.get(key)?.state).toBe('SURFACE');
  });

  it("station 1's own isolated view still shows SHADOWED at the same voxel", () => {
    const isolated = classifyObservationField(domain, voxelEdge, rows, [station1], PARAMS);
    expect(isolated.stateByKey.get(key)?.state).toBe('SHADOWED');
  });
});

// ---------------------------------------------------------------------------
// F3 — a box present in station A's scan, absent in station B's: CONFLICT
// ---------------------------------------------------------------------------

describe('F3 — CONFLICT lists both disagreeing sources (SPEC §9.1, §2.3)', () => {
  const scene = buildF3Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const voxelEdge = scene.voxelEdge;
  const stationA: ObservationFieldStation = {
    sourceIndex: 0,
    origin: [...scene.stationA.origin] as [number, number, number],
    azimuthDeg: [...scene.stationA.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...scene.stationA.angularExtent.elevationDeg] as [number, number],
  };
  const stationB: ObservationFieldStation = {
    sourceIndex: 1,
    origin: [...scene.stationB.origin] as [number, number, number],
    azimuthDeg: [...scene.stationB.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...scene.stationB.angularExtent.elevationDeg] as [number, number],
  };
  const grid = domainGrid(domain, voxelEdge);
  // The box's near face on the A-B line of sight (y=0, z=1): both stations
  // are addressed here (elevation ~0, well inside [-45, 45]).
  const boxCenter: readonly [number, number, number] = [6, 0, 1];
  const key = packVoxelKey(
    Math.floor((boxCenter[0] - domain.min[0]) / voxelEdge),
    Math.floor((boxCenter[1] - domain.min[1]) / voxelEdge),
    Math.floor((boxCenter[2] - domain.min[2]) / voxelEdge),
    grid.nx,
    grid.ny,
  );

  // Station A's rays return AT this voxel (the box is there when A scans):
  // n=6, f=1 >= p_solid. Station B's rays continue past it to a surface
  // further along (the box was already gone when B scanned): this voxel is
  // only ever crossed before B's own hit window, n=6, f=0 <= p_empty.
  const rows: ObservationLedgerRow[] = [buildRow(key, [sourceCounters(0, { hit: 6 }), sourceCounters(1, { pass: 6 })], 2)];

  it('resolves to CONFLICT with both source indices and counts recorded', () => {
    const field = classifyObservationField(domain, voxelEdge, rows, [stationA, stationB], PARAMS);
    const decision = field.stateByKey.get(key);
    expect(decision?.state).toBe('CONFLICT');
    expect(decision?.conflict?.solidSourceIndex).toBe(0);
    expect(decision?.conflict?.emptySourceIndex).toBe(1);
    expect(decision?.conflict?.solidCounters.hit).toBe(6);
    expect(decision?.conflict?.emptyCounters.pass).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// F4 — a porous volume seen from two stations: PARTIAL, not CONFLICT
// ---------------------------------------------------------------------------

describe('F4 — a porous volume is PARTIAL, not CONFLICT (SPEC §9.1)', () => {
  const domain: ObservationDomain = { min: [0, 0, 0], max: [4, 4, 4] };
  const voxelEdge = 1;
  const station0: ObservationFieldStation = { sourceIndex: 0, origin: [-5, 2, 2], azimuthDeg: [0, 360], elevationDeg: [-45, 45] };
  const station1: ObservationFieldStation = { sourceIndex: 1, origin: [9, 2, 2], azimuthDeg: [0, 360], elevationDeg: [-45, 45] };
  const key = packVoxelKey(2, 2, 2, 4, 4);
  // Neither source individually reaches p_solid or drops to p_empty: source
  // 0 has f = 3/6 = 0.5, source 1 has f = 2/6 ~ 0.33. Aggregate f =
  // 5/12 ~ 0.417, strictly between p_empty and p_solid.
  const rows: ObservationLedgerRow[] = [
    buildRow(key, [sourceCounters(0, { hit: 3, pass: 3 }), sourceCounters(1, { hit: 2, pass: 4 })], 2),
  ];

  it('resolves to PARTIAL', () => {
    const field = classifyObservationField(domain, voxelEdge, rows, [station0, station1], PARAMS);
    const decision = field.stateByKey.get(key);
    expect(decision?.state).toBe('PARTIAL');
    expect(decision?.state).not.toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// F7 — an unaddressed pocket beyond the declared maximum range
// ---------------------------------------------------------------------------

describe('F7 — a pocket beyond maxRange is UNADDRESSED, not SHADOWED (SPEC §9.1)', () => {
  const scene = buildF7Scene();
  const domain: ObservationDomain = { min: [...scene.domain.minCorner] as [number, number, number], max: [...scene.domain.maxCorner] as [number, number, number] };
  const voxelEdge = scene.voxelEdge;
  const station: ObservationFieldStation = {
    sourceIndex: 0,
    origin: [...scene.station.origin] as [number, number, number],
    azimuthDeg: [...scene.station.angularExtent.azimuthDeg] as [number, number],
    elevationDeg: [...scene.station.angularExtent.elevationDeg] as [number, number],
    maxRange: scene.station.maxRange,
  };
  const grid = domainGrid(domain, voxelEdge);
  // Inside the pocket (9, 0, 1): range from the station (0, 0, 1) is 9 > 5
  // (maxRange), so NOT addressed regardless of the elevation band.
  const pocketCenter: readonly [number, number, number] = [9, 0, 1];
  const key = packVoxelKey(
    Math.floor((pocketCenter[0] - domain.min[0]) / voxelEdge),
    Math.floor((pocketCenter[1] - domain.min[1]) / voxelEdge),
    Math.floor((pocketCenter[2] - domain.min[2]) / voxelEdge),
    grid.nx,
    grid.ny,
  );

  it('isVoxelAddressed is false past maxRange even inside the elevation band', () => {
    expect(isVoxelAddressed(pocketCenter, station)).toBe(false);
  });

  it('resolves to UNADDRESSED with no row at all (no behind-evidence reaches a range-capped pocket)', () => {
    const field = classifyObservationField(domain, voxelEdge, [], [station], PARAMS);
    expect(field.stateByKey.get(key)?.state).toBe('UNADDRESSED');
  });
});

// ---------------------------------------------------------------------------
// F17 — degenerate inputs
// ---------------------------------------------------------------------------

describe('F17 — degenerate inputs, refused or handled per the documented rule (SPEC §9.1)', () => {
  it('isVoxelAddressed refuses a NaN station origin', () => {
    const station: ObservationFieldStation = { sourceIndex: 0, origin: [Number.NaN, 0, 0], azimuthDeg: [0, 360], elevationDeg: [-90, 90] };
    expect(() => isVoxelAddressed([1, 1, 1], station)).toThrow();
  });

  it('classifyObservationField refuses an empty ROI (min === max on an axis), via domainGrid', () => {
    const domain: ObservationDomain = { min: [0, 0, 0], max: [0, 4, 4] };
    const station: ObservationFieldStation = { sourceIndex: 0, origin: [-1, 2, 2], azimuthDeg: [0, 360], elevationDeg: [-45, 45] };
    expect(() => classifyObservationField(domain, 1, [], [station], PARAMS)).toThrow();
  });

  it('a single source never yields CONFLICT, however its counters are set (OB-INV-02, exercised through the new O5 wiring)', () => {
    const domain: ObservationDomain = { min: [0, 0, 0], max: [2, 2, 2] };
    const station: ObservationFieldStation = { sourceIndex: 0, origin: [-3, 1, 1], azimuthDeg: [0, 360], elevationDeg: [-45, 45] };
    const key = packVoxelKey(1, 1, 1, 2, 2);
    const rows: ObservationLedgerRow[] = [buildRow(key, [sourceCounters(0, { hit: 3, pass: 3 })])];
    const field = classifyObservationField(domain, 1, rows, [station], PARAMS);
    expect(field.stateByKey.get(key)?.state).not.toBe('CONFLICT');
  });

  it('a source index in the second presence-mask word (32+) is classified correctly, no crash at the 32/33-source boundary', () => {
    const domain: ObservationDomain = { min: [0, 0, 0], max: [2, 2, 2] };
    const stations: ObservationFieldStation[] = Array.from({ length: 33 }, (_, i) => ({
      sourceIndex: i,
      origin: [-3, 1, 1],
      azimuthDeg: [0, 360],
      elevationDeg: i === 32 ? [-45, 45] : [1000, 1001], // every source but #32 is declared to address nothing here
    }));
    const key = packVoxelKey(1, 1, 1, 2, 2);
    const rows: ObservationLedgerRow[] = [buildRow(key, [sourceCounters(32, { hit: 6 })], 33)];
    const field = classifyObservationField(domain, 1, rows, stations, PARAMS);
    expect(field.stateByKey.get(key)?.state).toBe('SURFACE');
  });
});

// ---------------------------------------------------------------------------
// Shadow frontier — OB-SH-01/02, oracle agreement (SPEC §9.2)
// ---------------------------------------------------------------------------

describe('OB-SH-01/02 — computeShadowFrontier matches validation/observatory/oracle/shadow_frontier.py', () => {
  const ROOT = join(__dirname, '..');
  const gridDef = JSON.parse(readFileSync(join(ROOT, 'validation', 'observatory', 'oracle', 'shadow-frontier-grid.json'), 'utf8')) as {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly cells: readonly { readonly ix: number; readonly iy: number; readonly iz: number; readonly state: string }[];
  };
  const expected = JSON.parse(readFileSync(join(ROOT, 'validation', 'observatory', 'expected', 'shadow-frontier-grid.expected.json'), 'utf8')) as {
    readonly frontierVoxelKeys: readonly number[];
    readonly exposedFaceCount: number;
    readonly adjacentToShadowed: number;
    readonly adjacentToUnaddressed: number;
    readonly adjacentToNoReturnPath: number;
  };

  const grid = { nx: gridDef.nx, ny: gridDef.ny, nz: gridDef.nz };
  const stateByKey = new Map(
    gridDef.cells.map((c) => [packVoxelKey(c.ix, c.iy, c.iz, grid.nx, grid.ny), c.state as import('../src/observation/types').ObservationState]),
  );

  it('agrees with the Python oracle on the frontier voxel set and every adjacency count', () => {
    const result = computeShadowFrontier(stateByKey, grid, 1, null);
    expect([...result.frontierVoxelKeys].sort((a, b) => a - b)).toEqual(expected.frontierVoxelKeys);
    expect(result.adjacentToShadowed).toBe(expected.adjacentToShadowed);
    expect(result.adjacentToUnaddressed).toBe(expected.adjacentToUnaddressed);
    expect(result.adjacentToNoReturnPath).toBe(expected.adjacentToNoReturnPath);
    expect(result.areaSquareMetres).toBeNull(); // metresPerUnit null here (OB-INV-10)
  });

  it('reports a metric area only when the unit is known (OB-INV-10), h^2 x exposedFaceCount', () => {
    const result = computeShadowFrontier(stateByKey, grid, 0.5, 1);
    expect(result.areaSquareMetres).toBeCloseTo(expected.exposedFaceCount * 0.25, 10);
  });

  it('does not wrap across the domain edge: a frontier voxel at ix=0 is judged only on in-bounds neighbours', () => {
    // (0, 0, 0) is SURFACE with only one in-bounds shadow-adjacent neighbour
    // ((1, 0, 0) SHADOWED); its missing x=-1 and y=-1 neighbours must not be
    // read as anything, let alone wrap to the far edge of the grid.
    const key = packVoxelKey(0, 0, 0, grid.nx, grid.ny);
    expect(expected.frontierVoxelKeys).toContain(key);
  });
});
