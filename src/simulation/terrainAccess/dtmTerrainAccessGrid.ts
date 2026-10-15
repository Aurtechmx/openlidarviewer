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
 * Height above ground is `DSM − DTM` cell for cell, which is only meaningful
 * when cell i of one grid covers the same ground as cell i of the other. Equal
 * cols, rows and cell size are not enough: a surface with the same shape but a
 * different origin would subtract heights from different places. So the
 * surface must match the terrain's origin (within {@link ALIGNMENT_TOLERANCE}
 * of a cell), array lengths, row orientation, horizontal CRS and vertical unit
 * before anything is subtracted, and the surface must state its frame to be
 * checked at all. Anything else is a typed `SURFACE_MISALIGNED` refusal — never
 * a resample and never a guess.
 *
 * ── AN ROI MASK IS CHECKED, NOT WIDENED ─────────────────────────────────────
 * A declared region of interest that does not fit the grid (wrong length, or
 * values other than 0/1) is refused as `INVALID_ROI`. Ignoring it would route
 * over the whole grid while the caller believed the run was confined.
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
  readonly ok: true;
  readonly grid: TerrainAccessGrid;
  readonly basis: SimulationInputBasis;
  /** Reserved for non-fatal notes about the inputs; empty today. */
  readonly warnings: readonly string[];
}

/** Why the inputs could not be combined into one grid. */
export interface DtmTerrainAccessGridRefusal {
  readonly ok: false;
  readonly code: 'SURFACE_MISALIGNED' | 'INVALID_ROI';
  readonly reason: string;
}

/** The only row orientation `buildDtmGrid` produces: row 0 at `originH2`, rows running north. */
export const TERRAIN_GRID_ORIENTATION = 'rows-north-from-origin' as const;

/** The frame an above-ground surface was built in, stated so alignment can be checked. */
export interface AboveGroundFrame {
  readonly crs: string | null;
  readonly horizontalEpsg: number | null;
  /** Metres per surface Z unit. Must equal the terrain's own factor. */
  readonly verticalUnitToMetres: number | null;
  readonly orientation: typeof TERRAIN_GRID_ORIENTATION;
}

/** An above-ground surface (DSM) with the frame it was built in. */
export interface AboveGroundSurface extends SurfaceGrid {
  readonly frame: AboveGroundFrame;
}

/** Largest origin or cell-size difference, as a fraction of a cell, still read as the same grid. */
export const ALIGNMENT_TOLERANCE = 1e-6;

/**
 * Why `dsm` cannot be subtracted from `dtm` cell for cell, or null when it is
 * aligned. Reads every field at runtime: the surface may come from a restored
 * or programmatic caller whose object does not honour the type.
 */
export function aboveGroundAlignmentProblem(dtm: DtmGrid, dsm: AboveGroundSurface): string | null {
  const n = dtm.cols * dtm.rows;
  const tol = ALIGNMENT_TOLERANCE * dtm.cellSizeM;
  const close = (a: number, b: number): boolean => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  if (dsm.cols !== dtm.cols || dsm.rows !== dtm.rows) {
    return `its cols/rows (${dsm.cols}×${dsm.rows}) differ from the terrain's (${dtm.cols}×${dtm.rows})`;
  }
  if (!dsm.z || !dsm.coverage || dsm.z.length !== n || dsm.coverage.length !== n) {
    return `its array lengths (${dsm.z?.length}, ${dsm.coverage?.length}) differ from the terrain's ${n} cells`;
  }
  if (!close(dsm.cellSizeM, dtm.cellSizeM)) {
    return `its cell size (${dsm.cellSizeM}) differs from the terrain's (${dtm.cellSizeM})`;
  }
  if (!close(dsm.originH1, dtm.originH1) || !close(dsm.originH2, dtm.originH2)) {
    return `its origin (${dsm.originH1}, ${dsm.originH2}) differs from the terrain's (${dtm.originH1}, ${dtm.originH2})`;
  }
  const frame = dsm.frame;
  if (!frame) return 'it does not state the frame it was built in';
  if (frame.orientation !== TERRAIN_GRID_ORIENTATION) {
    return `its row orientation (${String(frame.orientation)}) differs from the terrain's (${TERRAIN_GRID_ORIENTATION})`;
  }
  if ((frame.crs ?? null) !== (dtm.crs ?? null) || (frame.horizontalEpsg ?? null) !== (dtm.horizontalEpsg ?? null)) {
    return `its horizontal CRS (${frame.crs ?? 'none'}) differs from the terrain's (${dtm.crs ?? 'none'})`;
  }
  const fz = frame.verticalUnitToMetres;
  const tz = dtm.verticalUnitToMetres;
  if (fz == null || tz == null || !(Math.abs(fz - tz) <= 1e-12 * Math.max(1, Math.abs(tz)))) {
    return `its vertical unit (${fz ?? 'unresolved'} m per unit) differs from the terrain's (${tz ?? 'unresolved'})`;
  }
  return null;
}

/** Why `roi` cannot confine a run over `n` cells, or null when it is a usable 0/1 mask. */
export function roiMaskProblem(roi: Uint8Array, n: number): string | null {
  if (!(roi instanceof Uint8Array) || roi.length !== n) {
    return `it holds ${roi?.length} cells, not the terrain's ${n}`;
  }
  for (let i = 0; i < n; i++) {
    if (roi[i] !== 0 && roi[i] !== 1) return `cell ${i} holds ${roi[i]}, not 0 or 1`;
  }
  return null;
}

/**
 * Convert the analysed DTM (+ optional aligned DSM) into a traversability
 * grid.
 *
 * `dsm` is optional: without it `heightAboveGround` is null and the
 * obstruction constraint in `traversabilityCost.ts` cannot be evaluated
 * (`terrainAccessPrepare.ts` refuses a profile that asks for it). A supplied
 * surface that is not aligned, or an ROI mask that does not fit, is refused.
 */
export function terrainDtmToAccessGrid(
  dtm: DtmGrid,
  scale: HorizontalScale,
  options: {
    readonly interpolated?: InterpolatedPolicy;
    readonly withheldExcluded?: boolean | null;
    readonly dsm?: AboveGroundSurface | null;
    readonly roi?: Uint8Array | null;
  } = {},
): DtmTerrainAccessGrid | DtmTerrainAccessGridRefusal {
  const policy = options.interpolated ?? 'route';
  const n = dtm.cols * dtm.rows;
  // The traversability core reads z as metres (slope, step height, ascent),
  // so source vertical units are converted here, once. The preparation step
  // refuses a run whose factor is unresolved before this is reached.
  const zToMetres = dtm.verticalUnitToMetres;
  if (zToMetres == null || !(zToMetres > 0) || !Number.isFinite(zToMetres)) {
    throw new Error(
      'terrainDtmToAccessGrid: the DTM vertical unit factor is unresolved; '
      + 'refusing to read elevations as metres without one.',
    );
  }
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
    z[i] = v * zToMetres;
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
    const problem = aboveGroundAlignmentProblem(dtm, dsm);
    if (problem) {
      return {
        ok: false, code: 'SURFACE_MISALIGNED',
        reason: `The supplied above-ground surface is not aligned to the terrain grid: ${problem}. `
          + 'Nothing is subtracted from a surface that does not cover the same cells.',
      };
    }
    const hag = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (valid[i] === 0 || dsm.coverage[i] === 0) { hag[i] = Number.NaN; continue; }
      hag[i] = dsm.z[i] * zToMetres - z[i];
    }
    heightAboveGround = hag;
  }

  let allowed: Uint8Array | null = null;
  if (options.roi) {
    const problem = roiMaskProblem(options.roi, n);
    if (problem) {
      return {
        ok: false, code: 'INVALID_ROI',
        reason: `The declared region of interest does not fit the terrain grid: ${problem}. `
          + 'The run is refused rather than widened to the whole grid.',
      };
    }
    allowed = options.roi;
  }

  return {
    ok: true,
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
