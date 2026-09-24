/**
 * terrainAccessPrepare.ts — the up-front preparation `runTerrainAccess` and
 * `prepareTerrainAccessPreview` both need before they diverge: refuse for
 * every precondition a route search or a traversability-map preview shares
 * (no DTM, an unresolved scale, an invalid profile, a grid too large, no
 * measured cell, no eligible cell), then hand back the grid/features/
 * eligibility a caller can build either a search or a map from.
 *
 * Extracted so the two callers cannot silently drift on what counts as a
 * valid profile or an unresolved scale — see `terrainAccessPreview.ts`'s own
 * module doc for why the split exists in the first place.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { terrainDtmToAccessGrid, type HorizontalScale, type InterpolatedPolicy } from './dtmTerrainAccessGrid';
import {
  DEFAULT_COST_WEIGHTS,
  applyWidthClearance,
  nodeEligibility,
  prepareTerrainAccessFeatures,
  type CostWeights,
  type NodeEligibility,
  type TerrainAccessFeatures,
} from './traversabilityCost';
import { validateProfile, type TerrainAccessGrid, type TerrainAccessProfile } from './terrainAccessTypes';
import type { SimulationInputBasis } from '../simulationInputBasis';
import type { TerrainAccessRefusal } from './terrainAccessRunner';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../../terrain/surface/buildDsm';

/** What a run or a preview needs in common, before either search or eligibility differ. */
export interface TerrainAccessPrepareParams {
  readonly interpolated: InterpolatedPolicy;
  readonly maxCells: number;
  readonly withheldExcluded: boolean | null;
  /** Above-ground surface, when available; optional per §12.4. */
  readonly dsm?: SurfaceGrid | null;
  /** Region-of-interest mask, when the caller has declared one. */
  readonly roi?: Uint8Array | null;
  readonly weights?: CostWeights;
}

/** Everything a completed preparation hands to the run or the preview. */
export interface TerrainAccessPrepared {
  readonly ok: true;
  readonly grid: TerrainAccessGrid;
  readonly features: TerrainAccessFeatures;
  readonly eligibility: NodeEligibility;
  readonly basis: SimulationInputBasis;
  readonly gridWarnings: readonly string[];
  readonly weights: CostWeights;
}

/**
 * Run every shared precondition check, in the fixed order both
 * `runTerrainAccess` and `prepareTerrainAccessPreview` document, and build
 * the grid/features/eligibility a search or a traversability map needs.
 */
export function prepareTerrainAccessRun(
  dtm: DtmGrid | null,
  scale: HorizontalScale,
  profile: TerrainAccessProfile,
  params: TerrainAccessPrepareParams,
): TerrainAccessPrepared | TerrainAccessRefusal {
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
    const problemList = profileProblems.map((p) => `${p.field} ${p.reason}`).join('; ');
    return {
      ok: false, code: 'INVALID_PROFILE',
      reason: `The mobility profile is not usable: ${problemList}.`,
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

  return { ok: true, grid, features, eligibility, basis, gridWarnings, weights };
}
