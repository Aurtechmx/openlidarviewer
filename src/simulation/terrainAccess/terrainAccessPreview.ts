/**
 * terrainAccessPreview.ts — everything a Terrain Access run needs up to, but
 * not including, the A* search itself: the grid, the terrain features, node
 * eligibility (post width-clearance) and the traversability map.
 *
 * The Lab needs this SPLIT from `runTerrainAccess` because start/goal
 * selection happens on the result grid AFTER the mobility profile is
 * declared — the traversability map is what a reader picks a start/goal cell
 * against — but a route search needs both endpoints already chosen. Rather
 * than duplicate `runTerrainAccess`'s own up-front refusal checks in the UI
 * layer (which risks the two silently drifting on what counts as a valid
 * profile or an unresolved scale), this module and `runTerrainAccess` both
 * call `prepareTerrainAccessRun` (`terrainAccessPrepare.ts`), the one place
 * those checks and the grid/features/eligibility build live.
 *
 * `runTerrainAccess` itself is unchanged: it still performs its own checks
 * independently (a caller that skips the preview and calls it directly still
 * gets every refusal), and this module composes the same shared preparation
 * rather than the reverse being the case, so the two can never disagree
 * about what stops a run.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { buildTraversabilityMap, type NodeEligibility, type TerrainAccessFeatures, type TraversabilityMapCell } from './traversabilityCost';
import { prepareTerrainAccessRun, type TerrainAccessPrepareParams } from './terrainAccessPrepare';
import type { TerrainAccessGrid, TerrainAccessProfile } from './terrainAccessTypes';
import { basisLimitations, type SimulationInputBasis } from '../simulationInputBasis';
import type { HorizontalScale } from './dtmTerrainAccessGrid';
import type { TerrainAccessRefusal, TerrainAccessRefusalCode } from './terrainAccessRunner';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/** Preview needs exactly what the shared preparation takes. */
export type TerrainAccessPreviewParams = TerrainAccessPrepareParams;

export interface TerrainAccessPreview {
  readonly ok: true;
  readonly grid: TerrainAccessGrid;
  readonly features: TerrainAccessFeatures;
  readonly eligibility: NodeEligibility;
  readonly map: readonly TraversabilityMapCell[];
  readonly basis: SimulationInputBasis;
  readonly limitations: readonly string[];
}

/** Refuse for exactly the codes a caller might reasonably act on before a search. */
export type TerrainAccessPreviewRefusalCode = Extract<
  TerrainAccessRefusalCode,
  'NO_DTM' | 'UNITS_UNRESOLVED' | 'INVALID_PROFILE' | 'TOO_LARGE' | 'INSUFFICIENT_EVIDENCE'
>;

export function prepareTerrainAccessPreview(
  dtm: DtmGrid | null,
  scale: HorizontalScale,
  profile: TerrainAccessProfile,
  params: TerrainAccessPreviewParams,
): TerrainAccessPreview | TerrainAccessRefusal {
  const prepared = prepareTerrainAccessRun(dtm, scale, profile, params);
  if (!prepared.ok) return prepared;
  const { grid, features, eligibility, basis, gridWarnings, weights } = prepared;

  const map = buildTraversabilityMap(grid, features, eligibility, profile, weights);

  return {
    ok: true,
    grid,
    features,
    eligibility,
    map,
    basis,
    limitations: [...basisLimitations(basis, 'terrain-access'), ...gridWarnings],
  };
}
