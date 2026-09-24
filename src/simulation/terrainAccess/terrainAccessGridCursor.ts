/**
 * terrainAccessGridCursor.ts — pure cell/cursor math for the Terrain Access
 * result grid, mirroring `flowPulse/flowGridCursor.ts` for the same reason:
 * `Viewer.ts` has no picking seam a lazy feature can reach without growing the
 * monolith, so start/goal selection and the why-not inspector both read a 2D
 * raster of the routed grid instead of the live scan. The cell/pixel/keyboard
 * arithmetic (`clampCell`, `moveCursor`, `pixelToCell`, `cellIndex`, `cellAt`)
 * is grid-shape-agnostic and is reused unchanged from `flowGridCursor.ts`
 * rather than duplicated; only the cell DESCRIPTION differs, because a
 * Terrain Access cell reports eligibility/cost/why-not, not flow status.
 *
 * Pure: no DOM, no three.js.
 */

import { cellIndex, type ElevationReference, type GridCell } from '../flowPulse/flowGridCursor';
import { whyNotEligible, type TerrainAccessFeatures, type NodeEligibility, type TraversabilityMapCell } from './traversabilityCost';
import type { TerrainAccessGrid, TerrainAccessProfile } from './terrainAccessTypes';

export {
  cellIndex, cellAt, clampCell, moveCursor, pixelToCell,
  type ElevationReference, type GridCell,
} from '../flowPulse/flowGridCursor';

/** A readable summary of one cell, for the live region and the selection panel. */
export interface TerrainAccessCellReport {
  readonly col: number;
  readonly row: number;
  readonly readable: boolean;
  /**
   * Real-world elevation in the resolved vertical unit — NOT the grid-local
   * z — or null when not readable, or the origin/unit did not resolve. See
   * `flowGridCursor.ts`'s `ElevationReference`, whose gate this reuses
   * unchanged: `TerrainAccessGrid.z` is the same load-time-recentred local
   * frame the DTM/DSM rasters are, not a real elevation on its own.
   */
  readonly elevation: number | null;
  /** 'm' / 'ft' when {@link elevation} is a real reading, 'unknown' otherwise; null when not readable. */
  readonly elevationUnit: 'm' | 'ft' | 'unknown' | null;
  readonly confidence: number | null;
  readonly mapState: string | null;
  readonly eligible: boolean | null;
}

const MAP_STATE_LABEL: Record<TraversabilityMapCell['state'], string> = {
  blocked: 'blocked',
  unknown: 'no data',
  'low-cost': 'low cost',
  'moderate-cost': 'moderate cost',
  'high-cost': 'high cost',
};

/**
 * Describe one cell from an already-built traversability map, for the live
 * region.
 *
 * `elevationRef` is optional so a caller with no resolved origin/vertical
 * unit still gets a report — with an honest 'unknown' elevation rather than
 * the grid's local-frame z passed off as a real height, exactly the gate
 * `flowGridCursor.ts`'s `describeCell` already enforces for Flow Pulse.
 */
export function describeTerrainAccessCell(
  grid: TerrainAccessGrid,
  map: readonly TraversabilityMapCell[],
  cell: GridCell,
  elevationRef: ElevationReference | null = null,
): TerrainAccessCellReport {
  const i = cellIndex(grid.cols, cell);
  const readable = grid.valid[i] === 1;
  const cellMap = map[i];
  const originZ = elevationRef?.originZ ?? null;
  const unitLabel = elevationRef?.unitLabel ?? 'units';
  const resolved = readable && originZ != null && unitLabel !== 'units';

  let elevation: number | null = null;
  let elevationUnit: 'm' | 'ft' | 'unknown' | null = null;
  if (readable) {
    if (resolved) {
      elevation = grid.z[i] + originZ!;
      elevationUnit = unitLabel as 'm' | 'ft';
    } else {
      elevationUnit = 'unknown';
    }
  }

  return {
    col: cell.col,
    row: cell.row,
    readable,
    elevation,
    elevationUnit,
    confidence: readable ? grid.confidence[i] : null,
    mapState: cellMap ? MAP_STATE_LABEL[cellMap.state] : null,
    eligible: cellMap ? cellMap.state !== 'blocked' && cellMap.state !== 'unknown' : null,
  };
}

/** One sentence for the live region announcing a cursor move. */
export function terrainAccessCellAnnouncement(report: TerrainAccessCellReport): string {
  if (!report.readable) return `Column ${report.col}, row ${report.row}, no elevation.`;
  const elevationText = report.elevation != null
    ? `elevation ${report.elevation.toFixed(2)} ${report.elevationUnit}`
    : 'elevation unknown';
  return `Column ${report.col}, row ${report.row}, ${elevationText}, `
    + `terrain support ${report.confidence!.toFixed(0)}, ${report.mapState ?? 'unknown'}.`;
}

/** One sentence per why-not reason, joined for the live region / inspector panel. */
export function whyNotSentence(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
  cell: GridCell,
): string {
  const i = cellIndex(grid.cols, cell);
  if (grid.valid[i] === 0) return `Column ${cell.col}, row ${cell.row}: no elevation is known at this cell.`;
  const result = whyNotEligible(grid, features, eligibility, profile, i);
  if (result.eligible) {
    return `Column ${cell.col}, row ${cell.row}: eligible — at least one neighbouring move is within the declared limits.`;
  }
  const detail = result.reasons.map((r) => r.detail).join('; ');
  const prefix = result.category === 'unknown' ? 'withheld (insufficient evidence)' : 'blocked';
  return `Column ${cell.col}, row ${cell.row}: ${prefix} — ${detail}.`;
}
