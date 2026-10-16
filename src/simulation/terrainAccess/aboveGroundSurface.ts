/**
 * aboveGroundSurface.ts — the above-ground surface Terrain Access subtracts
 * from the DTM, and the one way the app builds it.
 *
 * The terrain run already builds a top-surface DSM on the DTM's own grid
 * (`analyseContours.ts`, `buildDsm`). This module turns that grid into an
 * {@link AboveGroundSurface}: the same heights, the frame the DTM was built
 * in, and a binding to that DTM. Nothing is resampled. A DSM whose grid does
 * not match the DTM's gives no surface at all.
 *
 * ── THE BINDING ─────────────────────────────────────────────────────────────
 * Equal geometry and frame do not prove a surface belongs to a DTM: two runs
 * over the same extent share both. So the surface records `terrainDigest`,
 * the `dtmProductDigest` of the DTM it was built with, and
 * {@link aboveGroundBindingProblem} refuses a surface whose digest does not
 * match the terrain it is offered against. A surface kept from an earlier
 * run, or handed over from another layer, is refused rather than subtracted.
 *
 * ── THE BASIS ───────────────────────────────────────────────────────────────
 * The surface is the top return per cell of the points the terrain run read,
 * without noise returns. When those points are a sample of the scan, a thin
 * return (a post, a wire) is likely missed, so the obstruction limit read
 * from it is an estimate. `basis` states which; a DSM handed over without
 * one takes the terrain's coverage mode, with the counts unknown.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { dtmProductDigest } from '../../science/dtmProductDigest';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid, SurfaceSampleBasis } from '../../terrain/surface/buildDsm';

export type { SurfaceSampleBasis } from '../../terrain/surface/buildDsm';

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

/** An above-ground surface (DSM) with the frame it was built in and the terrain it belongs to. */
export interface AboveGroundSurface extends SurfaceGrid {
  readonly frame: AboveGroundFrame;
  /** `dtmProductDigest` of the DTM this surface was built with. */
  readonly terrainDigest: string;
  /** Which points the surface rests on. Absent on a surface built outside the
   *  terrain run; {@link aboveGroundBasisOf} then reads the terrain's coverage. */
  readonly basis?: SurfaceSampleBasis;
}

/** `basis` as supplied, or the one the terrain's coverage mode implies when it is absent. */
export function aboveGroundBasisOf(dtm: DtmGrid, dsm: { readonly basis?: SurfaceSampleBasis }): SurfaceSampleBasis {
  return dsm.basis ?? {
    sampled: dtm.coverageMode !== 'full',
    coverage: dtm.coverageMode,
    pointsRead: null,
    sourcePoints: null,
    noiseExcluded: 0,
    withheldExcluded: dtm.withheldExcluded ?? null,
  };
}

/**
 * Why `dsm` does not belong to `dtm`, or null when its binding matches. Reads
 * the field at runtime: a restored or programmatic caller may omit it.
 */
export function aboveGroundBindingProblem(dtm: DtmGrid, dsm: AboveGroundSurface): string | null {
  const bound = (dsm as { terrainDigest?: unknown }).terrainDigest;
  if (typeof bound !== 'string' || bound === '') {
    return 'it does not state which terrain run it was built with';
  }
  if (bound !== dtmProductDigest(dtm)) {
    return 'it was built with a different terrain surface than the one being routed';
  }
  return null;
}

const surfaceCache = new WeakMap<SurfaceGrid, {
  readonly dtm: DtmGrid; readonly basis: SurfaceSampleBasis | undefined; readonly surface: AboveGroundSurface;
}>();

/**
 * The above-ground surface for `dtm`, from the DSM the same terrain run built
 * and the basis it rests on, or null when there is none or its grid is not
 * the DTM's. Cached per DSM grid, so repeated reads of one result hash the
 * DTM once.
 */
export function aboveGroundSurfaceFromAnalysis(
  dtm: DtmGrid,
  dsm: SurfaceGrid | null | undefined,
  basis?: SurfaceSampleBasis,
): AboveGroundSurface | null {
  if (!dsm) return null;
  const cached = surfaceCache.get(dsm);
  if (cached && cached.dtm === dtm && cached.basis === basis) return cached.surface;
  const n = dtm.cols * dtm.rows;
  if (dsm.cols !== dtm.cols || dsm.rows !== dtm.rows || dsm.z.length !== n || dsm.coverage.length !== n
    || dsm.cellSizeM !== dtm.cellSizeM || dsm.originH1 !== dtm.originH1 || dsm.originH2 !== dtm.originH2) {
    return null;
  }
  const surface: AboveGroundSurface = {
    z: dsm.z,
    coverage: dsm.coverage,
    cols: dsm.cols,
    rows: dsm.rows,
    cellSizeM: dsm.cellSizeM,
    originH1: dsm.originH1,
    originH2: dsm.originH2,
    frame: {
      crs: dtm.crs ?? null,
      horizontalEpsg: dtm.horizontalEpsg ?? null,
      verticalUnitToMetres: dtm.verticalUnitToMetres ?? null,
      orientation: TERRAIN_GRID_ORIENTATION,
    },
    terrainDigest: dtmProductDigest(dtm),
    basis: aboveGroundBasisOf(dtm, { basis }),
  };
  surfaceCache.set(dsm, { dtm, basis, surface });
  return surface;
}
