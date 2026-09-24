/**
 * terrainAccessGridCursor.test.ts — the cell readout behind the Terrain
 * Access result grid, in particular the real-elevation gate `flowGridCursor`
 * already enforces for Flow Pulse: the grid's local `z` must never be printed
 * as if it were a real elevation.
 */
import { describe, expect, it } from 'vitest';

import {
  describeTerrainAccessCell,
  terrainAccessCellAnnouncement,
} from '../src/simulation/terrainAccess/terrainAccessGridCursor';
import type { TraversabilityMapCell } from '../src/simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid } from '../src/simulation/terrainAccess/terrainAccessTypes';

describe('describeTerrainAccessCell — elevation reference', () => {
  const grid: TerrainAccessGrid = {
    z: Float32Array.from([2, 5, Number.NaN, 1]),
    valid: Uint8Array.from([1, 1, 0, 1]),
    confidence: Float32Array.from([90, 80, 0, 70]),
    coverage: Uint8Array.from([2, 2, 0, 2]),
    heightAboveGround: null,
    allowed: null,
    cols: 2, rows: 2,
    cellMetresX: 1, cellMetresY: 1,
  };
  const map: TraversabilityMapCell[] = [
    { state: 'low-cost' }, { state: 'moderate-cost' }, { state: 'unknown' }, { state: 'blocked' },
  ] as TraversabilityMapCell[];

  it('withholds elevation with no reference (grid-local z is not a real elevation)', () => {
    const report = describeTerrainAccessCell(grid, map, { col: 1, row: 0 });
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBe('unknown');
    expect(terrainAccessCellAnnouncement(report)).toBe(
      'Column 1, row 0, elevation unknown, terrain support 80, moderate cost.',
    );
  });

  it('reports a real elevation with unit when the origin and vertical unit resolve', () => {
    const report = describeTerrainAccessCell(grid, map, { col: 1, row: 0 }, { originZ: 1232, unitLabel: 'm' });
    expect(report.elevation).toBeCloseTo(1237, 6);
    expect(report.elevationUnit).toBe('m');
    expect(terrainAccessCellAnnouncement(report)).toBe(
      'Column 1, row 0, elevation 1237.00 m, terrain support 80, moderate cost.',
    );
  });

  it('reports elevation unknown when the vertical unit did not resolve', () => {
    const report = describeTerrainAccessCell(grid, map, { col: 1, row: 0 }, { originZ: 1232, unitLabel: 'units' });
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBe('unknown');
  });

  it('reports elevation unknown when the origin did not resolve', () => {
    const report = describeTerrainAccessCell(grid, map, { col: 1, row: 0 }, { originZ: null, unitLabel: 'm' });
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBe('unknown');
  });

  it('withholds elevation and unit for an unreadable cell regardless of reference', () => {
    const report = describeTerrainAccessCell(grid, map, { col: 0, row: 1 }, { originZ: 1232, unitLabel: 'm' });
    expect(report.readable).toBe(false);
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBeNull();
    expect(terrainAccessCellAnnouncement(report)).toBe('Column 0, row 1, no elevation.');
  });
});
