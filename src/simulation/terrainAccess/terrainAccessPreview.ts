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

import {
  buildTraversabilityMap, DERIVATIVE_CAUSE_BOUNDARY, DERIVATIVE_CAUSE_HOLE,
  type NodeEligibility, type TerrainAccessFeatures, type TraversabilityMapCell,
} from './traversabilityCost';
import { derivativeEstimateGridStatement } from './terrainAccessExplain';
import { prepareTerrainAccessRun, type TerrainAccessPrepareParams } from './terrainAccessPrepare';
import { resolveEvidenceGapPolicy, type TerrainAccessGrid, type TerrainAccessProfile } from './terrainAccessTypes';
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
  | 'NO_DTM' | 'UNITS_UNRESOLVED' | 'INVALID_PROFILE' | 'INVALID_WEIGHTS' | 'TOO_LARGE' | 'INSUFFICIENT_EVIDENCE'
  | 'OBSTRUCTION_EVIDENCE_UNAVAILABLE' | 'SURFACE_MISALIGNED' | 'SURFACE_STALE' | 'INVALID_ROI' | 'INVALID_GRID'
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
    limitations: [
      ...basisLimitations(basis, 'terrain-access'),
      ...gridWarnings,
      ...previewEstimateLimitations(grid, features, profile),
    ],
  };
}

/**
 * Under the exploratory policy, the grid cells whose grade and cross slope
 * will be estimates (slope from a substituted neighbour), by cause, in the
 * words a run's `estimated` status uses. Under conservative they are blocked
 * and the eligibility map already shows it.
 */
function previewEstimateLimitations(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  profile: TerrainAccessProfile,
): string[] {
  if (resolveEvidenceGapPolicy(profile) !== 'exploratory') return [];
  let boundary = 0;
  let hole = 0;
  for (let i = 0; i < features.derivativeSupportCause.length; i++) {
    if (grid.valid[i] === 0) continue;
    if (features.derivativeSupportCause[i] === DERIVATIVE_CAUSE_BOUNDARY) boundary++;
    else if (features.derivativeSupportCause[i] === DERIVATIVE_CAUSE_HOLE) hole++;
  }
  return boundary + hole === 0 ? [] : [derivativeEstimateGridStatement(boundary + hole, boundary, hole)];
}
