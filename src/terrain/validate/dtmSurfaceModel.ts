/**
 * dtmSurfaceModel.ts
 *
 * Adapts the real DTM pipeline to the `SurfaceModel` interface the spatial-block
 * estimator consumes, so blocked cross-validation scores the SAME surface the
 * user is shown (same rasteriser, same despike, same void-fill), not a toy
 * predictor. `fit` rebuilds the DTM on a FIXED grid from the fold's training
 * points; `predict` reads it back with the bilinear interpolation the hold-out
 * uses, so a point near a data edge still predicts from the covered corners.
 *
 * The grid is fixed at construction (the full-scene grid), so every fold's
 * surface lands on the same cells and predictions are comparable across folds.
 * A held-out block has no training returns of its own; it is predicted only if
 * the void-fill reached into it from neighbouring blocks — which is exactly the
 * "predict across a real gap" case the blocked estimate is meant to measure.
 *
 * Cost note: each `fit` is a full rasterise + surface build, so k folds do k
 * rebuilds. The caller bounds this (a cell-count cap and a sampled point set);
 * see `analyseContours`.
 *
 * Pure data: no DOM, no three.js, no I/O.
 */

import type { TerrainPoint } from '../TerrainContracts';
import { rasterizeDtm, type DtmAggregation } from '../ground/rasterizeDtm';
import { buildSurfaceFromRaster } from '../ground/surfaceFromRaster';
import type { SurfaceModel, XYZ } from './spatialBlockHoldout';

export interface DtmSurfaceGrid {
  readonly originH1: number;
  readonly originH2: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

export interface DtmSurfaceOptions {
  readonly grid: DtmSurfaceGrid;
  readonly aggregation?: DtmAggregation;
  readonly isGeographic?: boolean;
  readonly latitudeDeg?: number | null;
  readonly horizontalUnitToMetres?: number;
  readonly targetCount?: number;
}

/**
 * A `SurfaceModel` backed by the production DTM builder on a fixed grid. `fit`
 * rebuilds the surface from training points; `predict` bilinearly samples it.
 * The x/y/z of the injected {@link XYZ} points are treated as (h1, h2, v) in the
 * caller's chosen up-frame — the caller maps its axis before feeding points in.
 */
export class DtmSurfaceModel implements SurfaceModel {
  private z: Float32Array | null = null;
  private coverage: Uint8Array | null = null;
  private readonly opts: DtmSurfaceOptions;
  private readonly g: DtmSurfaceGrid;

  constructor(opts: DtmSurfaceOptions) {
    this.opts = opts;
    this.g = opts.grid;
  }

  fit(train: readonly XYZ[]): void {
    const pts: TerrainPoint[] = train.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const raster = rasterizeDtm(pts, new Uint8Array(pts.length).fill(1), {
      grid: {
        originH1: this.g.originH1,
        originH2: this.g.originH2,
        cols: this.g.cols,
        rows: this.g.rows,
        cellSizeM: this.g.cellSizeM,
      },
      aggregation: this.opts.aggregation ?? 'median',
      // The points are already mapped into the up-frame (v = z), so the
      // rasteriser treats z as vertical.
      verticalAxis: 'z',
    });
    const { dtm } = buildSurfaceFromRaster(raster, {
      targetCount: this.opts.targetCount,
      isGeographic: this.opts.isGeographic,
      latitudeDeg: this.opts.latitudeDeg,
      horizontalUnitToMetres: this.opts.horizontalUnitToMetres,
    });
    this.z = dtm.z;
    this.coverage = dtm.coverage;
  }

  predict(x: number, y: number): number | null {
    const z = this.z;
    const cov = this.coverage;
    if (!z || !cov) return null;
    const { cols, rows, cellSizeM, originH1, originH2 } = this.g;
    const fx = (x - originH1) / cellSizeM - 0.5;
    const fy = (y - originH2) / cellSizeM - 0.5;
    // Refuse out-of-domain queries. The valid interpolation range in cell-centre
    // space is [-0.5, cols-0.5] × [-0.5, rows-0.5]; beyond it the corner clamp
    // below would extrapolate by snapping to an edge cell and quietly return a
    // fabricated height. A query outside the grid has no prediction: return null.
    if (fx < -0.5 || fx > cols - 0.5 || fy < -0.5 || fy > rows - 0.5) return null;
    const col0 = Math.floor(fx);
    const row0 = Math.floor(fy);
    const tx = fx - col0;
    const ty = fy - row0;
    const clampCol = (c: number) => (c < 0 ? 0 : c >= cols ? cols - 1 : c);
    const clampRow = (r: number) => (r < 0 ? 0 : r >= rows ? rows - 1 : r);
    const corners: ReadonlyArray<readonly [number, number, number]> = [
      [clampCol(col0), clampRow(row0), (1 - tx) * (1 - ty)],
      [clampCol(col0 + 1), clampRow(row0), tx * (1 - ty)],
      [clampCol(col0), clampRow(row0 + 1), (1 - tx) * ty],
      [clampCol(col0 + 1), clampRow(row0 + 1), tx * ty],
    ];
    let sumW = 0;
    let sumZ = 0;
    for (const [cc, cr, w] of corners) {
      const idx = cr * cols + cc;
      if (w <= 0 || cov[idx] === 0 || !Number.isFinite(z[idx])) continue;
      sumW += w;
      sumZ += w * z[idx];
    }
    return sumW > 0 ? sumZ / sumW : null;
  }
}
