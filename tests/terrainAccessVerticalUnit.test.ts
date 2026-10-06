/**
 * terrainAccessVerticalUnit.test.ts — a DTM whose elevations are in US survey
 * feet must give the same route diagnostics as the same terrain in metres.
 * The grid's z is converted to metres once, where the DTM becomes a Terrain
 * Access grid, so slope, step height, ascent and descent are all in metres.
 */
import { describe, expect, it } from 'vitest';

import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { terrainDtmToAccessGrid, type HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import { describeTerrainAccessCell } from '../src/simulation/terrainAccess/terrainAccessGridCursor';
import { buildTerrainAccessMapBuffers, terrainAccessOverlayFrame } from '../src/render/terrainAccessOverlayGeometry';
import { prepareTerrainAccessPreview } from '../src/simulation/terrainAccess/terrainAccessPreview';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const FT = 1200 / 3937; // US survey foot in metres

/** A 5 x 1 ramp rising `risePerCell` source units per 1 m cell. */
function ramp(risePerCell: number, verticalUnitToMetres: number): DtmGrid {
  const w = 5;
  const z = new Float32Array(w);
  for (let c = 0; c < w; c++) z[c] = c * risePerCell;
  return {
    z, confidence: new Float32Array(w).fill(100), coverage: new Uint8Array(w).fill(2),
    counts: new Uint32Array(w).fill(1), interpDistanceCells: new Float32Array(w),
    cols: w, rows: 1, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres, coverageMode: 'full', sourcePointCount: w, analyzedPointCount: w,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

const RESOLVED: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'l', filename: 'f', sourceDigest: null, analysisInputDigest: 'd',
  build: 'b', id: 'r', generatedAt: '2026-01-01T00:00:00.000Z', processingManifestHead: null,
};
const profile = (over: Partial<TerrainAccessProfile> = {}): TerrainAccessProfile => ({
  name: 't', maxLongitudinalGrade: 10, maxCrossSlope: 10, maxStepHeight: 10, maxRuggedness: null,
  vehicleWidth: 0, vehicleLength: null, minimumTerrainConfidence: 0, unknownPolicy: 'block',
  obstacleHeightThreshold: null, ...over,
});

describe('vertical unit', () => {
  it('converts grid z to metres once', () => {
    const { grid } = terrainDtmToAccessGrid(ramp(10, FT), RESOLVED);
    expect(grid.z[4]).toBeCloseTo(40 * FT, 4);
  });

  it('reports ascent in metres for a feet DTM', () => {
    // 4 cells x 10 ft = 40 ft = 12.192 m.
    const r = runTerrainAccess(ramp(10, FT), RESOLVED, profile(), 0, 4, TERRAIN_ACCESS_DEFAULTS, identity);
    if (!r.ok) throw new Error(r.reason);
    expect(r.diagnostics.totalAscentM).toBeCloseTo(40 * FT, 3);
  });

  it('gives the same diagnostics as the same terrain in metres', () => {
    const feet = runTerrainAccess(ramp(10, FT), RESOLVED, profile(), 0, 4, TERRAIN_ACCESS_DEFAULTS, identity);
    const metres = runTerrainAccess(ramp(10 * FT, 1), RESOLVED, profile(), 0, 4, TERRAIN_ACCESS_DEFAULTS, identity);
    if (!feet.ok || !metres.ok) throw new Error('fixture refused');
    expect(feet.diagnostics.maxLongitudinalGrade).toBeCloseTo(metres.diagnostics.maxLongitudinalGrade, 4);
    expect(feet.diagnostics.maxEdgeStepM).toBeCloseTo(metres.diagnostics.maxEdgeStepM, 4);
    expect(feet.cost).toBeCloseTo(metres.cost, 3);
  });

  it('does not over-block: a step of 10 ft is 3.048 m, under a 3.1 m limit', () => {
    const r = runTerrainAccess(ramp(10, FT), RESOLVED, profile({ maxStepHeight: 3.1 }), 0, 4, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
  });

  it('the cell readout still reads the source unit', () => {
    const prev = prepareTerrainAccessPreview(ramp(10, FT), RESOLVED, profile(), TERRAIN_ACCESS_DEFAULTS);
    if (!prev.ok) throw new Error(prev.reason);
    const report = describeTerrainAccessCell(prev.grid, prev.map, { col: 4, row: 0 }, {
      originZ: 100, unitLabel: 'ft', metresPerVerticalUnit: FT,
    });
    expect(report.elevation).toBeCloseTo(140, 3);
    expect(report.elevationUnit).toBe('ft');
  });

  it('draws the overlay at the scene height, in the DTM vertical unit', () => {
    const prev = prepareTerrainAccessPreview(ramp(10, FT), RESOLVED, profile(), TERRAIN_ACCESS_DEFAULTS);
    if (!prev.ok) throw new Error(prev.reason);
    const frame = terrainAccessOverlayFrame('z', 0, 0, 1, FT);
    const buf = buildTerrainAccessMapBuffers(prev.grid, prev.map, frame);
    // Cell 4 sits at 40 ft; its quad corners carry that height as the third coordinate.
    const heights = Array.from({ length: buf.verts.length / 3 }, (_, k) => buf.verts[k * 3 + 2]);
    expect(Math.max(...heights)).toBeCloseTo(40, 3);
  });
});
