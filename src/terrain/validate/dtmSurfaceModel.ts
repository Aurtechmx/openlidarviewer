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
  /**
   * Vertical-unit → metre scale, passed straight through to
   * {@link buildSurfaceFromRaster}. The live pipeline supplies it (it scales the
   * despike floor and the confidence roughness); the validation surface must
   * carry the SAME value so a foot-vertical scan is not validated against a
   * metre-scaled surface.
   */
  readonly verticalUnitToMetres?: number;
  /**
   * Run the blunder-only despike before building the surface. The live pipeline
   * turns this OFF on the trusted-classification path (`trustGroundClassification`),
   * where measured ground returns are authoritative and a steep survey node must
   * not be void-filled as a spike, and leaves it ON otherwise. The field
   * validator MUST pass the SAME value the shipped surface used, or it scores a
   * different surface. Defaults to the live builder's default (on) when omitted.
   */
  readonly despike?: boolean;
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
      verticalUnitToMetres: this.opts.verticalUnitToMetres,
      // Faithful reproduction of the shipped surface: the despike decision the
      // live builder made (off on the trusted-classification path) is passed
      // through so the validated grid is the delivered grid, not a despiked
      // variant of it. Omitted → undefined → the live builder's default (on).
      despike: this.opts.despike,
    });
    this.z = dtm.z;
    this.coverage = dtm.coverage;
  }

  /**
   * The grid produced by the most recent {@link fit}: the same `z` heights and
   * per-cell `coverage` the live builder returns. Exposed so a field validator
   * can assert the validated surface is byte-for-byte the shipped surface (the
   * DTM parity invariant), rather than inferring it through sampled `predict`.
   * Returns `null` before the first `fit`.
   */
  builtGrid(): { readonly z: Float32Array; readonly coverage: Uint8Array } | null {
    if (!this.z || !this.coverage) return null;
    return { z: this.z, coverage: this.coverage };
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
    const clampCol = (c: number): number => {
      if (c < 0) return 0;
      if (c >= cols) return cols - 1;
      return c;
    };
    const clampRow = (r: number): number => {
      if (r < 0) return 0;
      if (r >= rows) return rows - 1;
      return r;
    };
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
