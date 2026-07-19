/**
 * cellConfidence.ts
 *
 * Pure-data leaf — and the load-bearing one for the honesty
 * contract. Takes a raw `DemRaster` (which leaves empty cells as `NaN`)
 * and produces a complete `DtmGrid`: every cell has an elevation AND a
 * 0..100 confidence describing how much that elevation can be trusted.
 *
 * WHY this matters. The key reliability principle
 * was that a confidence band you never derive from real evidence is
 * unfalsifiable — i.e. dishonest. Here confidence is computed once, per
 * cell, from observable quantities, and becomes the single source of
 * truth every downstream view reads: contour solid/dashed/gap, the
 * confidence-map overlay, and the per-contour banding in exports. No
 * other module recomputes uncertainty.
 *
 * Confidence model (documented so it can be argued with, not hidden):
 *   - MEASURED cell (>=1 ground return): confidence rises with sample
 *     density relative to the scene's typical density (median count).
 *     A cell sampled at or above the median is fully trusted on the
 *     density axis; a thinly-sampled cell is proportionally less so.
 *   - INTERPOLATED cell (no ground return, value filled from nearest
 *     data): confidence falls with distance-to-data (each cell of
 *     interpolation distance costs trust) AND with local surface
 *     roughness (interpolating across rough ground is a bigger guess
 *     than across flat ground).
 *   - A cell with no reachable data at all stays `value: null`
 *     equivalent — confidence 0, coverage `none` — so the UI renders a
 *     true "—"/gap rather than a fabricated height.
 *
 * The thresholds are constants here, not magic numbers buried in a
 * renderer: `solid`/`dashed`/`gap` cutoffs live with the data so the
 * grammar is consistent everywhere.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainCoverageMode } from '../TerrainContracts';
import type { DemRaster } from './rasterizeDtm';
import { inpaintNearest } from './groundFilter';
import { idwFill } from './idwFill';
import { geodesicFill } from './geodesicFill';
import { hornSlope } from './terrainDerivatives';
import { horizontalCellMetresXY } from './horizontalScale';

/** Per-cell provenance: how the elevation in this cell came to be. */
export type CellCoverage =
  | 0 // none — no reachable data; height is undefined, confidence 0
  | 1 // interpolated — filled from nearest measured cell
  | 2; // measured — at least one ground return landed here

/** Evidence grade derived from confidence — the shared visual grammar. */
export type EvidenceGrade = 'solid' | 'dashed' | 'gap';

/** Confidence cutoffs for the evidence grades (single source of truth). */
export const EVIDENCE_THRESHOLDS = {
  /** >= solid → drawn as a confident, continuous line. */
  solid: 66,
  /** >= dashed (and < solid) → drawn dashed: "interpolated, uncertain". */
  dashed: 33,
  // < dashed → `gap`: not drawn / drawn as an explicit break.
} as const;

/** Map a 0..100 confidence to its evidence grade. */
export function gradeForConfidence(confidence: number): EvidenceGrade {
  if (!Number.isFinite(confidence) || confidence < EVIDENCE_THRESHOLDS.dashed) return 'gap';
  if (confidence < EVIDENCE_THRESHOLDS.solid) return 'dashed';
  return 'solid';
}

/**
 * The confidence-aware DTM. This is the product; contours, hillshade,
 * exports, and the confidence overlay are all projections of it.
 */
export interface DtmGrid {
  /** Elevation per cell, row-major. Filled (never NaN) where `coverage>0`. */
  readonly z: Float32Array;
  /** 0..100 trust per cell. */
  readonly confidence: Float32Array;
  /** Per-cell provenance. */
  readonly coverage: Uint8Array; // values are CellCoverage
  /** Ground-return count per cell (0 for interpolated/none). */
  readonly counts: Uint32Array;
  /** Interpolation distance in cells (0 for measured cells). */
  readonly interpDistanceCells: Float32Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
  /** Horizontal CRS identifier (e.g. "EPSG:32610") or null when unknown. */
  readonly crs: string | null;
  /** Vertical datum identifier (e.g. "EPSG:5703") or null when unknown. */
  readonly verticalDatum: string | null;
  // ── honesty contract (whole-grid summary) ─────────────────────────
  readonly coverageMode: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  /** Mean confidence over cells that carry a height (coverage>0). */
  readonly meanConfidence: number;
  readonly warnings: string[];
}

/** Options for {@link buildDtmGrid}. */
export interface CellConfidenceParams {
  /**
   * Ground returns per cell that earns full density confidence. When
   * omitted, the scene's own median measured count is used (robust to
   * outliers) — the grid is judged against its own typical density.
   */
  readonly targetCount?: number;
  /**
   * Surface slope (rise/run) at which interpolation roughness fully
   * penalises an interpolated cell. Default 1.0 (45°). Steeper local
   * ground means a riskier interpolation.
   */
  readonly roughnessFullPenaltySlope?: number;
  /** Horizontal CRS, passed through to the grid (no export without it). */
  readonly crs?: string | null;
  /** Vertical datum, passed through to the grid. */
  readonly verticalDatum?: string | null;
  /**
   * Absolute sample-adequacy half-count: the per-cell ground-return count
   * at which the absolute-density factor reaches 0.5. A measured cell's
   * density confidence is `relative × absolute`, where `absolute =
   * count / (count + halfCount)`. This stops a 1-return cell in a sparse
   * scene from scoring 100% just because it matches the (low) scene
   * median. Default 3. Set 0 to disable the absolute floor (relative
   * only — the pre-0.4 behaviour).
   */
  readonly absoluteHalfCount?: number;
  /**
   * DTM hardening — withhold (don't interpolate) cells whose interpolation
   * distance exceeds this many cells: far-reach fill is unreliable, so the
   * cell becomes a genuine gap (coverage 0) instead of an invented surface.
   * Undefined = no limit (interpolate every reachable cell, the default).
   */
  readonly maxInterpDistanceCells?: number;
  /**
   * DTM hardening — withhold interpolated cells whose local surface slope
   * (rise/run, Horn) exceeds this: interpolating across steep ground invents
   * the least trustworthy surface. Undefined = no limit (the default).
   */
  readonly maxInterpSlope?: number;
  /**
   * True when the horizontal frame is geographic (degrees), so the roughness
   * slope converts the cell size to metres. Default false (projected).
   */
  readonly isGeographic?: boolean;
  /**
   * WORLD grid-centre latitude (degrees) for the geographic cos φ E–W scale.
   * The raster origin is usually render-recentred (≈ 0), which would silently
   * degrade cos φ to 1 — so callers that know the cloud's world origin must
   * pass the real latitude here. Null / omitted falls back to the
   * raster-origin estimate (correct only for un-recentred grids).
   */
  readonly latitudeDeg?: number | null;
  /**
   * Metres per source horizontal unit (~0.3048 for feet) for a projected frame,
   * so the roughness slope's run is in metres. Ignored when `isGeographic`
   * (metres-per-degree is used instead). Default 1.
   */
  readonly horizontalUnitToMetres?: number;
  /**
   * Metres per source VERTICAL unit (~0.3048 for feet). The roughness slope's
   * rise is in native Z units, so it is scaled to metres to match the metres
   * run — otherwise a foot-CRS DTM reads ~3.28× too rough and its confidence
   * is understated. Default 1 (metric, or Z already in metres).
   */
  readonly verticalUnitToMetres?: number;
  /**
   * Void interpolation method. `'geodesic'` measures distance along the
   * surface (won't fill a valley void from across a ridge); `'idw'` is the
   * plain Euclidean inverse-distance blend. Default `'idw'`.
   */
  readonly interpolation?: 'idw' | 'geodesic';
  /**
   * DTM hardening — extrapolation guard. An interpolated cell whose
   * supporting data lies only on one side is an *extrapolation*, not an
   * interpolation, and is the least trustworthy filled surface: there is no
   * data bracketing it, so the height is a directional guess. The guard
   * scans eight rays out to `radiusCells` and measures the angular spread of
   * the directions in which data is found; a cell whose data is confined to
   * an arc narrower than 180° is "one-sided".
   *   - `penalty` (default 0.5) multiplies a one-sided cell's confidence, so
   *     a confident extrapolation is demoted toward dashed/gap.
   *   - `dropSingleDirection` (default false), when true, drops a cell with
   *     data in only a single ray-direction to a genuine gap (coverage 0).
   * Undefined disables the guard entirely (the default — backwards compatible).
   */
  readonly extrapolationGuard?: {
    readonly radiusCells?: number;
    readonly penalty?: number;
    readonly dropSingleDirection?: boolean;
  };
}

/**
 * Build a confidence-aware DTM from a raw raster. Deterministic.
 */
export function buildDtmGrid(raster: DemRaster, params: CellConfidenceParams = {}): DtmGrid {
  const warnings = [...raster.warnings];
  const { cols, rows, cellSizeM, originH1, originH2 } = raster;
  const nCells = cols * rows;

  if (nCells === 0) {
    return {
      z: new Float32Array(0),
      confidence: new Float32Array(0),
      coverage: new Uint8Array(0),
      counts: new Uint32Array(0),
      interpDistanceCells: new Float32Array(0),
      cols,
      rows,
      cellSizeM,
      originH1,
      originH2,
      crs: params.crs ?? null,
      verticalDatum: params.verticalDatum ?? null,
      coverageMode: 'full',
      sourcePointCount: raster.sourcePointCount,
      analyzedPointCount: raster.analyzedPointCount,
      meanConfidence: Number.NaN,
      warnings,
    };
  }

  // had-data mask from counts.
  const hadData = new Uint8Array(nCells);
  for (let i = 0; i < nCells; i++) hadData[i] = raster.counts[i] > 0 ? 1 : 0;

  // Fill heights. IDW (inverse-distance over the k nearest measured
  // cells) gives a smooth, locally-supported interpolant; nearest-finite
  // is the fallback for reachable cells that fall outside the IDW search
  // radius, so every reachable cell still gets a finite height and the
  // coverage semantics below are unchanged. Measured cells keep their
  // own value verbatim. (v0.4.0 — was nearest-neighbour everywhere.)
  const nearest = inpaintNearest(raster.z, hadData, cols, rows);
  const idw =
    params.interpolation === 'geodesic'
      ? geodesicFill(raster.z, hadData, cols, rows, { cellSizeM })
      : idwFill(raster.z, hadData, cols, rows, {});
  const z = new Float32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    if (hadData[i] === 1) z[i] = raster.z[i];
    else z[i] = Number.isFinite(idw[i]) ? idw[i] : nearest[i];
  }

  // Distance-to-data in cells (multi-source BFS, 8-connectivity).
  const interpDistanceCells = distanceToData(hadData, cols, rows);

  // Target density: explicit, else median of measured counts.
  const target = params.targetCount ?? medianMeasuredCount(raster.counts);
  const safeTarget = target > 0 ? target : 1;
  const roughFull = params.roughnessFullPenaltySlope ?? 1.0;
  const absoluteHalfCount = Math.max(0, params.absoluteHalfCount ?? 3);
  const maxInterpDist = params.maxInterpDistanceCells;
  const maxInterpSlope = params.maxInterpSlope;
  const guard = params.extrapolationGuard != null;
  const guardRadius = Math.max(1, Math.round(params.extrapolationGuard?.radiusCells ?? 8));
  const guardPenalty = clamp01(params.extrapolationGuard?.penalty ?? 0.5);
  const guardDrop = params.extrapolationGuard?.dropSingleDirection ?? false;

  // Horn 3x3 slope — isotropic, the same estimator GDAL/ArcGIS use —
  // drives the interpolation roughness penalty. (v0.4.0 — was a crude
  // max-neighbour difference.) For a geographic frame the cell is in degrees,
  // so convert to metres per axis — longitude shrinks by cos(latitude) — or
  // every cell reads as near-vertical and the E–W run is overstated off-equator.
  const cellM = horizontalCellMetresXY(
    cellSizeM,
    params.isGeographic,
    // Prefer the caller's WORLD latitude: the raster origin is render-
    // recentred for viewer-fed grids (≈ 0 → cos φ silently 1). The origin
    // fallback stays correct for grids built in absolute coordinates.
    params.latitudeDeg ?? originH2 + (rows / 2) * cellSizeM,
    params.horizontalUnitToMetres,
  );
  const slope = hornSlope(z, cols, rows, cellM.x, cellM.y, params.verticalUnitToMetres ?? 1);

  const confidence = new Float32Array(nCells);
  const coverage = new Uint8Array(nCells);
  let confSum = 0;
  let confCells = 0;

  const anyData = raster.filledCellCount > 0;
  for (let i = 0; i < nCells; i++) {
    if (!anyData) {
      coverage[i] = 0;
      confidence[i] = 0;
      continue;
    }
    if (raster.counts[i] > 0) {
      // measured. Density confidence combines RELATIVE adequacy (count vs
      // the scene's typical density) with ABSOLUTE adequacy (count vs a
      // half-saturation floor), so a single-return cell is never fully
      // trusted just because the whole scene is sparse. absoluteHalfCount
      // = 0 disables the floor (pre-0.4 relative-only behaviour).
      coverage[i] = 2;
      const count = raster.counts[i];
      const relative = clamp01(count / safeTarget);
      const absolute = absoluteHalfCount > 0 ? count / (count + absoluteHalfCount) : 1;
      confidence[i] = Math.round(100 * relative * absolute);
    } else if (Number.isFinite(interpDistanceCells[i])) {
      // interpolated from reachable data — unless DTM hardening withholds it.
      const tooFar = maxInterpDist != null && interpDistanceCells[i] > maxInterpDist;
      const tooSteep = maxInterpSlope != null && slope[i] > maxInterpSlope;
      if (tooFar || tooSteep) {
        // Far-reach or steep interpolation is the least trustworthy surface —
        // leave it a genuine gap rather than invent it.
        coverage[i] = 0;
        confidence[i] = 0;
      } else {
        const interpScore = 1 / (1 + interpDistanceCells[i]);
        const roughPenalty = clamp01(slope[i] / (roughFull > 0 ? roughFull : 1)) * 0.8;
        let base = interpScore * (1 - roughPenalty);
        // Extrapolation guard: a fill supported only on one side is a
        // directional guess, not a bracketed interpolation. Demote it (or
        // drop it to a gap when configured) so one-sided surface can't read
        // as confident.
        if (guard) {
          const sup = directionalSupport(hadData, cols, rows, i % cols, (i - (i % cols)) / cols, guardRadius);
          if (guardDrop && sup.directions <= 1) {
            coverage[i] = 0;
            confidence[i] = 0;
            continue;
          }
          if (sup.directions > 0 && sup.oneSided) base *= guardPenalty;
        }
        coverage[i] = 1;
        confidence[i] = Math.round(100 * base);
      }
    } else {
      // unreachable — genuine gap
      coverage[i] = 0;
      confidence[i] = 0;
    }
    if (coverage[i] > 0) {
      confSum += confidence[i];
      confCells++;
    }
  }

  if (params.crs == null) {
    warnings.push('CRS unknown — exports must resolve a CRS before they are usable downstream');
  }

  return {
    z,
    confidence,
    coverage,
    counts: raster.counts,
    interpDistanceCells,
    cols,
    rows,
    cellSizeM,
    originH1,
    originH2,
    crs: params.crs ?? null,
    verticalDatum: params.verticalDatum ?? null,
    coverageMode: raster.coverage,
    sourcePointCount: raster.sourcePointCount,
    analyzedPointCount: raster.analyzedPointCount,
    meanConfidence: confCells > 0 ? confSum / confCells : Number.NaN,
    warnings,
  };
}

/**
 * Structural honesty guard for a DtmGrid. A DtmGrid
 * is honest when its arrays are length-consistent, confidences are in
 * range, and no `measured`/`interpolated` cell carries a non-finite
 * height (only `coverage: none` cells may lack a height).
 */
export function isHonestDtm(g: DtmGrid): boolean {
  const n = g.cols * g.rows;
  if (
    g.z.length !== n ||
    g.confidence.length !== n ||
    g.coverage.length !== n ||
    g.counts.length !== n ||
    g.interpDistanceCells.length !== n
  ) {
    return false;
  }
  for (let i = 0; i < n; i++) {
    const c = g.confidence[i];
    if (!Number.isFinite(c) || c < 0 || c > 100) return false;
    if (g.coverage[i] > 0 && !Number.isFinite(g.z[i])) return false;
  }
  return true;
}

// ── helpers ─────────────────────────────────────────────────────────

/**
 * Distance (in cells) from each cell to the nearest cell that had data,
 * by multi-source BFS over 8-connectivity. Measured cells are 0.
 * Unreachable cells (no data anywhere connected) are `Infinity`.
 */
export function distanceToData(hadData: Uint8Array, cols: number, rows: number): Float32Array {
  const n = cols * rows;
  const dist = new Float32Array(n).fill(Infinity);
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) {
    if (hadData[i] === 1) {
      dist[i] = 0;
      frontier.push(i);
    }
  }
  let step = 0;
  while (frontier.length > 0) {
    step++;
    const next: number[] = [];
    for (const i of frontier) {
      const col = i % cols;
      const row = (i - col) / cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
          const j = r * cols + c;
          if (dist[j] !== Infinity) continue;
          dist[j] = step;
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Directional data support around an interpolated cell. Marches the eight
 * compass rays out to `radius` cells and records, for each, whether a
 * measured (had-data) cell is encountered. Returns how many of the eight
 * directions found data and whether that data is "one-sided" — i.e. confined
 * to an arc narrower than 180°, the signature of an extrapolation rather than
 * a bracketed interpolation.
 *
 * Exported for testing. Deterministic, pure.
 */
export function directionalSupport(
  hadData: Uint8Array,
  cols: number,
  rows: number,
  col: number,
  row: number,
  radius: number,
): { directions: number; oneSided: boolean } {
  // Eight rays, in degrees around the circle (order matters for the gap calc).
  const rays: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 0], // E
    [1, 1, 45], // SE (screen-space; sign is irrelevant to the arc width)
    [0, 1, 90], // S
    [-1, 1, 135], // SW
    [-1, 0, 180], // W
    [-1, -1, 225], // NW
    [0, -1, 270], // N
    [1, -1, 315], // NE
  ];
  const hitAngles: number[] = [];
  for (const [dc, dr, deg] of rays) {
    for (let t = 1; t <= radius; t++) {
      const c = col + dc * t;
      const r = row + dr * t;
      if (c < 0 || c >= cols || r < 0 || r >= rows) break;
      if (hadData[r * cols + c] === 1) {
        hitAngles.push(deg);
        break;
      }
    }
  }
  const directions = hitAngles.length;
  if (directions === 0) return { directions: 0, oneSided: false };
  if (directions === 1) return { directions: 1, oneSided: true };
  // Largest empty arc between consecutive hit directions (wrapping 360°).
  hitAngles.sort((a, b) => a - b);
  let maxGap = 360 - hitAngles[hitAngles.length - 1] + hitAngles[0];
  for (let k = 1; k < hitAngles.length; k++) {
    const gap = hitAngles[k] - hitAngles[k - 1];
    if (gap > maxGap) maxGap = gap;
  }
  // Data confined to an arc < 180° ⇒ the cell is not bracketed ⇒ one-sided.
  return { directions, oneSided: maxGap > 180 };
}

/** Median of the positive (measured) counts; 0 when none are measured. */
function medianMeasuredCount(counts: Uint32Array): number {
  const measured: number[] = [];
  for (let i = 0; i < counts.length; i++) if (counts[i] > 0) measured.push(counts[i]);
  if (measured.length === 0) return 0;
  measured.sort((a, b) => a - b);
  const mid = measured.length >> 1;
  return measured.length % 2 === 1 ? measured[mid] : (measured[mid - 1] + measured[mid]) / 2;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
