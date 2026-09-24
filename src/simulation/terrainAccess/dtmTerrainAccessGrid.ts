/**
 * dtmTerrainAccessGrid.ts — the seam between the canonical DTM (+ optional
 * DSM) and the traversability core.
 *
 * `traversabilityCost.ts` and `aStarTerrain.ts` deliberately know nothing
 * about `DtmGrid` or `SurfaceGrid`, so a 3×3 terrain can be written by hand in
 * a test. This is the one module that knows all three, following exactly the
 * translation `flowPulse/dtmFlowGrid.ts` makes for flow routing — the same
 * NoData-is-a-wall rule, the same per-axis metric cell size, the same
 * Withheld-declaration passthrough — so the two simulations cannot disagree
 * about what a cell of this DTM means.
 *
 * ── THE ABOVE-GROUND LAYER IS A SEPARATE, ALIGNED GRID ──────────────────────
 * `buildDsm.ts` documents that the DSM is "Built on the SAME grid as the DTM
 * so the two align cell-for-cell". This module trusts that documented
 * contract rather than re-deriving alignment: it requires the DSM's cols,
 * rows and cell size to equal the DTM's and refuses (returns a null height
 * layer with a warning) rather than resample or guess an alignment that was
 * not actually verified.
 */

import { horizontalCellMetresXY } from '../../terrain/ground/horizontalScale';
import { simulationInputBasis, type SimulationInputBasis } from '../simulationInputBasis';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../../terrain/surface/buildDsm';
import type { TerrainAccessGrid } from './terrainAccessTypes';

/** `CellCoverage` values, named so the comparison below reads as intent. */
const COVERAGE_NONE = 0;
const COVERAGE_INTERPOLATED = 1;

/** How the source's horizontal coordinates relate to metres. Same shape as
 * `flowPulse/dtmFlowGrid.ts`'s `HorizontalScale`, redeclared here rather than
 * imported so the two simulations do not share a type whose meaning could
 * drift under one of them without the other noticing. */
export interface HorizontalScale {
  readonly isGeographic: boolean;
  readonly latitudeDeg: number | null;
  readonly unitToMetres: number;
  readonly resolved: boolean;
}

/** What a routing pass does with a cell whose height was interpolated. */
export type InterpolatedPolicy = 'route' | 'block';

/** A terrain-access grid built from a DTM (+ optional DSM), with its basis. */
export interface DtmTerrainAccessGrid {
  readonly grid: TerrainAccessGrid;
  readonly basis: SimulationInputBasis;
  /** Non-empty only when a supplied DSM could not be aligned to the DTM. */
  readonly warnings: readonly string[];
}

/**
 * Convert the analysed DTM (+ optional aligned DSM) into a traversability
 * grid.
 *
 * `dsm` is optional: without it `heightAboveGround` is null and the
 * obstruction constraint in `traversabilityCost.ts` is simply inactive,
 * exactly as §12.4 of the governing prompt requires ("optionally use aligned
 * DSM/nDSM").
 */
export function terrainDtmToAccessGrid(
  dtm: DtmGrid,
  scale: HorizontalScale,
  options: {
    readonly interpolated?: InterpolatedPolicy;
    readonly withheldExcluded?: boolean | null;
    readonly dsm?: SurfaceGrid | null;
    readonly roi?: Uint8Array | null;
  } = {},
): DtmTerrainAccessGrid {
  const policy = options.interpolated ?? 'route';
  const n = dtm.cols * dtm.rows;
  // NaN-filled, not zero-filled: `hornSlopeAspect` (terrainDerivatives.ts) has
  // no `valid` mask of its own — it takes `!Number.isFinite(z[i])` as its own
  // "no data here" signal, matching the convention `DtmGrid.z` already uses
  // for an unsupported cell. A zero-filled array would read every NoData cell
  // as a real elevation of 0 m, and Horn's 3×3 window would then let that
  // fake elevation pollute the slope/aspect of every VALID neighbouring cell
  // — silently, on any terrain that is not itself flat at 0 m.
  const z = new Float32Array(n).fill(Number.NaN);
  const valid = new Uint8Array(n);
  const confidence = new Float32Array(n);
  const coverage = new Uint8Array(n);

  let readable = 0;
  let interpolated = 0;
  let policyExcluded = 0;
  for (let i = 0; i < n; i++) {
    const cover = dtm.coverage[i];
    if (cover === COVERAGE_NONE) continue;
    const isInterpolated = cover === COVERAGE_INTERPOLATED;
    if (isInterpolated && policy === 'block') { policyExcluded++; continue; }
    const v = dtm.z[i];
    if (!Number.isFinite(v)) continue;
    if (isInterpolated) interpolated++;
    z[i] = v;
    valid[i] = 1;
    confidence[i] = dtm.confidence[i];
    coverage[i] = cover;
    readable++;
  }

  const metres = horizontalCellMetresXY(
    dtm.cellSizeM,
    scale.isGeographic,
    scale.latitudeDeg,
    scale.unitToMetres,
  );

  const warnings: string[] = [];
  let heightAboveGround: Float32Array | null = null;
  if (options.dsm) {
    const dsm = options.dsm;
    if (dsm.cols !== dtm.cols || dsm.rows !== dtm.rows || dsm.cellSizeM !== dtm.cellSizeM) {
      warnings.push(
        'The supplied above-ground surface is not built on the same grid as the terrain '
        + '(cols/rows/cell size differ), so above-ground obstruction evidence is withheld.',
      );
    } else {
      const hag = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        if (valid[i] === 0 || dsm.coverage[i] === 0) { hag[i] = Number.NaN; continue; }
        hag[i] = dsm.z[i] - z[i];
      }
      heightAboveGround = hag;
    }
  }

  let allowed: Uint8Array | null = null;
  if (options.roi) {
    if (options.roi.length !== n) {
      warnings.push('The supplied ROI mask does not match the terrain grid size, so it is ignored.');
    } else {
      allowed = options.roi;
    }
  }

  return {
    grid: {
      z, valid, confidence, coverage, heightAboveGround, allowed,
      cols: dtm.cols, rows: dtm.rows,
      cellMetresX: metres.x, cellMetresY: metres.y,
    },
    basis: simulationInputBasis({
      coverage: dtm.coverageMode,
      withheldExcluded: options.withheldExcluded ?? dtm.withheldExcluded ?? null,
      horizontalScaleResolved: scale.resolved,
      measuredCells: readable,
      interpolatedCells: interpolated,
      policyExcludedCells: policyExcluded,
      totalCells: n,
    }),
    warnings,
  };
}
