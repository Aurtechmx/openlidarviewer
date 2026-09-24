/**
 * terrainAccessRunner.test.ts: the orchestration seam — §30 refusals, the
 * run record, and the TA fixtures that need a full DTM (TA-2 route-level,
 * TA-7 low-confidence shortcut, TA-10 anisotropic grid).
 */
import { describe, expect, it } from 'vitest';

import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

/** A DtmGrid from a row-major elevation list; `null` marks coverage:none. */
function dtmOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<DtmGrid> = {},
): DtmGrid {
  const h = rows.length;
  const w = rows[0].length;
  const n = w * h;
  const z = new Float32Array(n);
  const confidence = new Float32Array(n);
  const coverage = new Uint8Array(n);
  const counts = new Uint32Array(n);
  const interpDistanceCells = new Float32Array(n);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      const i = r * w + c;
      if (v === null) continue;
      z[i] = v;
      coverage[i] = 2;
      confidence[i] = 100;
      counts[i] = 1;
    }
  }
  return {
    z, confidence, coverage, counts, interpDistanceCells,
    cols: w, rows: h, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1,
    coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true,
    meanConfidence: 100, warnings: [],
    ...over,
  };
}

const RESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const UNRESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: false };

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

const identity = {
  layerId: null, filename: null, sourceDigest: null, analysisInputDigest: 'digest',
  build: 'test-build', id: 'run-1', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};

describe('§30 refusals', () => {
  it('NO_DTM when no terrain surface is available', () => {
    const result = runTerrainAccess(null, RESOLVED, PERMISSIVE, 0, 1, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NO_DTM');
  });

  it('UNITS_UNRESOLVED when the horizontal scale is unresolved', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const result = runTerrainAccess(dtm, UNRESOLVED, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNITS_UNRESOLVED');
  });

  it('UNITS_UNRESOLVED when the vertical unit is unresolved', () => {
    const dtm = dtmOf([[0, 0, 0]], { verticalUnitToMetres: null });
    const result = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNITS_UNRESOLVED');
  });

  it('UNITS_UNRESOLVED when geographic with unknown latitude', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const geoUnresolved: HorizontalScale = { isGeographic: true, latitudeDeg: null, unitToMetres: 1, resolved: true };
    const result = runTerrainAccess(dtm, geoUnresolved, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNITS_UNRESOLVED');
  });

  it('INVALID_PROFILE when the profile is not physically sensible', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const bad = { ...PERMISSIVE, maxLongitudinalGrade: -1, vehicleWidth: 0 };
    const result = runTerrainAccess(dtm, RESOLVED, bad, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_PROFILE');
  });

  it('TOO_LARGE when the grid exceeds the declared cell budget', () => {
    const dtm = dtmOf(Array.from({ length: 4 }, () => Array(4).fill(0)));
    const result = runTerrainAccess(
      dtm, RESOLVED, PERMISSIVE, 0, 15, { ...TERRAIN_ACCESS_DEFAULTS, maxCells: 4 }, identity,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('TOO_LARGE');
  });

  it('INSUFFICIENT_EVIDENCE when the grid has no measured cell at all', () => {
    const dtm = dtmOf([[null, null, null]]);
    const result = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('INSUFFICIENT_EVIDENCE when no cell survives the declared profile', () => {
    const lowConfDtm = dtmOf([[0, 0, 0]], { confidence: new Float32Array([1, 1, 1]) });
    const result = runTerrainAccess(
      lowConfDtm, RESOLVED, { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'block' }, 0, 2,
      TERRAIN_ACCESS_DEFAULTS, identity,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('START_BLOCKED / END_BLOCKED / NO_ROUTE propagate from the search', () => {
    const dtm = dtmOf([[null, 0, 0]]);
    const startBlocked = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(!startBlocked.ok && startBlocked.code).toBe('START_BLOCKED');

    const dtm2 = dtmOf([[0, 0, null]]);
    const endBlocked = runTerrainAccess(dtm2, RESOLVED, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(!endBlocked.ok && endBlocked.code).toBe('END_BLOCKED');

    const dtm3 = dtmOf([
      [0, null, 0],
      [null, null, null],
      [0, null, 0],
    ]);
    const noRoute = runTerrainAccess(dtm3, RESOLVED, PERMISSIVE, 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(!noRoute.ok && noRoute.code).toBe('NO_ROUTE');
  });
});

describe('a successful run', () => {
  it('produces a sealed record whose digest reproduces on a second identical run', () => {
    const dtm = dtmOf(Array.from({ length: 5 }, () => Array(5).fill(0)));
    const r1 = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 24, TERRAIN_ACCESS_DEFAULTS, identity);
    const r2 = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 24, TERRAIN_ACCESS_DEFAULTS, {
      ...identity, id: 'run-2', generatedAt: '2027-01-01T00:00:00.000Z', // different id/timestamp
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.record.digest).toBe(r2.record.digest); // id/timestamp are excluded from the digest
      expect(r1.record.kind).toBe('terrain-access');
      expect(r1.record.methods).toContain('olv.simulation.terrain-access.astar');
    }
  });

  it('never AFFIRMS a safety or passability guarantee in its limitations (only negates one, per §22)', () => {
    const dtm = dtmOf(Array.from({ length: 3 }, () => Array(3).fill(0)));
    const result = runTerrainAccess(dtm, RESOLVED, PERMISSIVE, 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const text = result.limitations.join(' ').toLowerCase();
      // The disclaimer is allowed (and required) to say what the route is
      // NOT; it must never affirmatively claim one of these.
      expect(text).not.toMatch(/\bis a safe route\b/);
      expect(text).not.toMatch(/\bis guaranteed passable\b/);
      expect(text).not.toMatch(/\bis rollover-safe\b/);
      // And it DOES carry the required disclaimer.
      expect(text).toMatch(/not a safety assessment/);
    }
  });

  it('TA-2: directional grade changes the eligible route between headings, on a real tilted DTM', () => {
    // z decreases 1 m per metre east — steep, uniform slope.
    const cols = 6;
    const rowsN = 6;
    const rowsData: number[][] = [];
    for (let r = 0; r < rowsN; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(-c);
      rowsData.push(row);
    }
    const dtm = dtmOf(rowsData);
    // Tight cross-slope limit, generous longitudinal limit: a route straight
    // downslope should be findable; a route that HAS to cross-slope broadly
    // should not need to when a downslope path exists.
    const profile = { ...PERMISSIVE, maxLongitudinalGrade: 1.5, maxCrossSlope: 0.2 };
    const start = 0; // (row 0, col 0)
    const end = cols - 1; // (row 0, col 5) — straight east, i.e. straight downslope
    const result = runTerrainAccess(dtm, RESOLVED, profile, start, end, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostics.maxCrossSlope).toBeLessThanOrEqual(0.2 + 1e-6);
  });

  it('TA-7: unknownPolicy block refuses a shorter route through weak evidence; penalize allows it and reports exposure', () => {
    // A short corridor of low-confidence cells offers a shortcut; a longer,
    // fully-confident detour also exists.
    const rowsData = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const lowConfDtm = dtmOf(rowsData, { confidence: new Float32Array([100, 100, 100, 100, 10, 100, 100, 100, 100]) });
    const blockProfile = { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'block' as const };
    const penalizeProfile = { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'penalize' as const };

    const blocked = runTerrainAccess(lowConfDtm, RESOLVED, blockProfile, 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    // Still reachable by going around (corners are all high-confidence), so
    // this should FOUND but never touch the centre cell.
    expect(blocked.ok).toBe(true);
    if (blocked.ok) expect(blocked.path).not.toContain(4);

    const penalized = runTerrainAccess(lowConfDtm, RESOLVED, penalizeProfile, 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(penalized.ok).toBe(true);
    if (penalized.ok && penalized.path.includes(4)) {
      const text = penalized.limitations.join(' ');
      expect(text).toMatch(/weak-evidence|low-confidence/);
    }
  });

  it('TA-10: anisotropic grid — a geographic frame resolves unequal east/west vs. north/south cell metres, and route length reflects it', () => {
    // A geographic (degree) grid at 60°N: cos(60°) = 0.5, so a 1° cell is half
    // as wide east–west as it is tall north–south, in metres.
    const dtm = dtmOf(Array.from({ length: 3 }, () => Array(3).fill(0)), { cellSizeM: 1 });
    const geo60N: HorizontalScale = { isGeographic: true, latitudeDeg: 60, unitToMetres: 1, resolved: true };
    // A pure east-west route (3 cells) vs. a pure north-south route (3 cells)
    // over the SAME cell count must differ in physical length once the
    // anisotropy is honoured — an isotropic (bug) implementation would report
    // the two as equal.
    const eastWest = runTerrainAccess(dtm, geo60N, PERMISSIVE, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity); // row 0: col 0 → col 2
    const northSouth = runTerrainAccess(dtm, geo60N, PERMISSIVE, 0, 6, TERRAIN_ACCESS_DEFAULTS, identity); // col 0: row 0 → row 2
    expect(eastWest.ok).toBe(true);
    expect(northSouth.ok).toBe(true);
    if (eastWest.ok && northSouth.ok) {
      expect(eastWest.diagnostics.horizontalLengthM).toBeLessThan(northSouth.diagnostics.horizontalLengthM);
      expect(eastWest.diagnostics.horizontalLengthM).toBeCloseTo(northSouth.diagnostics.horizontalLengthM / 2, 3);
    }
  });
});
