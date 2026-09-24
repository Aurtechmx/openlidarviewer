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
 * profile or an unresolved scale), this module reuses the exact same checks,
 * in the exact same order, and simply stops before the search.
 *
 * `runTerrainAccess` itself is unchanged: it still performs its own checks
 * independently (a caller that skips the preview and calls it directly still
 * gets every refusal), and this module composes it rather than the reverse
 * being the case, so the two can never disagree about what stops a run.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { terrainDtmToAccessGrid, type HorizontalScale, type InterpolatedPolicy } from './dtmTerrainAccessGrid';
import {
  DEFAULT_COST_WEIGHTS,
  applyWidthClearance,
  buildTraversabilityMap,
  nodeEligibility,
  prepareTerrainAccessFeatures,
  type CostWeights,
  type NodeEligibility,
  type TerrainAccessFeatures,
  type TraversabilityMapCell,
} from './traversabilityCost';
import { validateProfile, type TerrainAccessGrid, type TerrainAccessProfile } from './terrainAccessTypes';
import { basisLimitations, type SimulationInputBasis } from '../simulationInputBasis';
import type { TerrainAccessRefusal, TerrainAccessRefusalCode } from './terrainAccessRunner';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../../terrain/surface/buildDsm';

export interface TerrainAccessPreviewParams {
  readonly interpolated: InterpolatedPolicy;
  readonly maxCells: number;
  readonly withheldExcluded: boolean | null;
  readonly dsm?: SurfaceGrid | null;
  readonly roi?: Uint8Array | null;
  readonly weights?: CostWeights;
}

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
  if (!dtm) {
    return {
      ok: false, code: 'NO_DTM',
      reason: 'No terrain surface is available. Run terrain analysis on a loaded scan first.',
    };
  }

  if (!scale.resolved) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The horizontal scale is unresolved, so longitudinal grade, cross slope and step '
        + 'height cannot be interpreted safely. Assign a CRS that resolves the horizontal scale.',
    };
  }
  if (scale.isGeographic && !Number.isFinite(scale.latitudeDeg ?? Number.NaN)) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The terrain is in geographic degrees and its latitude is unknown, so the '
        + 'east–west length of a cell cannot be derived. Assign a CRS that resolves the latitude.',
    };
  }
  const verticalUnitToMetres = dtm.verticalUnitToMetres;
  if (verticalUnitToMetres == null || !(verticalUnitToMetres > 0)) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The vertical unit is unresolved, so an elevation difference cannot be interpreted '
        + 'in metres and grade/step constraints cannot be interpreted safely.',
    };
  }

  const profileProblems = validateProfile(profile);
  if (profileProblems.length > 0) {
    return {
      ok: false, code: 'INVALID_PROFILE',
      reason: `The mobility profile is not usable: ${profileProblems.map((p) => `${p.field} ${p.reason}`).join('; ')}.`,
    };
  }

  const cells = dtm.cols * dtm.rows;
  if (cells > params.maxCells) {
    return {
      ok: false, code: 'TOO_LARGE',
      reason: `The terrain grid holds ${cells} cells, above the ${params.maxCells} this run allows. `
        + 'Analyse a smaller extent or a coarser cell size.',
    };
  }

  const { grid, basis, warnings: gridWarnings } = terrainDtmToAccessGrid(dtm, scale, {
    interpolated: params.interpolated,
    withheldExcluded: params.withheldExcluded,
    dsm: params.dsm,
    roi: params.roi,
  });

  if (basis.measuredCells === 0) {
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: params.interpolated === 'block'
        ? 'No cell carries a measured elevation. Allow interpolated cells, or analyse terrain with more ground returns.'
        : 'No cell in the terrain grid carries an elevation.',
    };
  }

  const features = prepareTerrainAccessFeatures(grid, profile);
  const eligibilityBeforeWidth = nodeEligibility(grid, features, profile);
  const eligibility = applyWidthClearance(grid, eligibilityBeforeWidth, profile);

  let eligibleCount = 0;
  for (const b of eligibility.blocked) if (b === 0) eligibleCount++;
  if (eligibleCount === 0) {
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: 'No cell in the terrain grid is eligible under the declared mobility profile. '
        + 'Relax the profile\'s limits, or analyse terrain with better support.',
    };
  }

  const weights = params.weights ?? DEFAULT_COST_WEIGHTS;
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
