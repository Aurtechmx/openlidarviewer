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

import {
  terrainDtmToAccessGrid, type AboveGroundSurface, type HorizontalScale, type InterpolatedPolicy,
} from './dtmTerrainAccessGrid';
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
import { topBlockReasonSentence } from './terrainAccessExplain';
import type { SimulationInputBasis } from '../simulationInputBasis';
import type { TerrainAccessRefusal } from './terrainAccessRunner';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/**
 * The one sentence for an above-ground obstruction limit that cannot be
 * evaluated: shown beside the disabled form control and at the head of the
 * refusal a restored or programmatic profile gets, so both say the same thing.
 */
export const ABOVE_GROUND_UNAVAILABLE = 'Above-ground evidence unavailable; this constraint cannot be evaluated.';

/** What a run or a preview needs in common, before either search or eligibility differ. */
export interface TerrainAccessPrepareParams {
  readonly interpolated: InterpolatedPolicy;
  readonly maxCells: number;
  readonly withheldExcluded: boolean | null;
  /** Above-ground surface, when available; optional per §12.4, and checked for alignment. */
  readonly dsm?: AboveGroundSurface | null;
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

  const built = terrainDtmToAccessGrid(dtm, scale, {
    interpolated: params.interpolated,
    withheldExcluded: params.withheldExcluded,
    dsm: params.dsm,
    roi: params.roi,
  });
  if (!built.ok) return built;
  const { grid, basis, warnings: gridWarnings } = built;

  // An obstruction limit with no above-ground layer would leave every cell
  // 'not-evaluated', which eligibility does not block: the run would carry the
  // limit in its parameters while never applying it. Refuse instead.
  if (profile.obstacleHeightThreshold != null && grid.heightAboveGround == null) {
    return {
      ok: false, code: 'OBSTRUCTION_EVIDENCE_UNAVAILABLE',
      reason: `${ABOVE_GROUND_UNAVAILABLE} The profile sets an above-ground obstruction limit of `
        + `${profile.obstacleHeightThreshold} m, but no aligned above-ground surface is available for this terrain. `
        + 'Turn the obstruction limit off to run without it.',
    };
  }

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
  if (eligibleCount === 0 && eligibilityBeforeWidth.blocked.some((b) => b === 0)) {
    // Cells exist that the declared limits accept, but the footprint fits on
    // none of them: say so, rather than reporting the map as supported.
    const widthM = profile.vehicleWidth;
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: `The declared vehicle width (${widthM} m) fits nowhere on the supported terrain: every cell the `
        + `profile's limits accept is closer than half that width (${widthM / 2} m) to unsupported terrain `
        + 'or the survey edge. Declare a narrower vehicle, or analyse a wider extent.',
    };
  }
  if (eligibleCount === 0) {
    const top = topBlockReasonSentence(eligibility, profile);
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: 'No cell in the terrain grid is eligible under the declared mobility profile. '
        + (top ? `${top} ` : '')
        + 'Relax the profile\'s limits, or analyse terrain with better support.',
    };
  }

  const weights = params.weights ?? DEFAULT_COST_WEIGHTS;

  return { ok: true, grid, features, eligibility, basis, gridWarnings, weights };
}
