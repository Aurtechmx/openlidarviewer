/**
 * terrainPositionIndex.ts
 *
 * Pure-data leaf — Topographic Position Index (TPI) and the six-class
 * slope-position classification, implemented from the primary literature:
 *
 *   Weiss, A. D. (2001). "Topographic Position and Landforms Analysis."
 *   Poster presentation, ESRI User Conference, San Diego, CA.
 *   (TPI = elevation of a cell minus the mean elevation of its
 *   neighbourhood; slope position classified from TPI standardised to
 *   the neighbourhood's standard deviation, with a slope test separating
 *   flat from mid-slope.)
 *
 * No third-party implementation was consulted or ported. Definitions:
 *
 *   TPI_i     = z_i − mean(z_j : j in window(i), j valid, j ≠ i)
 *   stdTPI_i  = (TPI_i − mean(TPI)) / stdev(TPI)   over all valid cells
 *
 * Six slope-position classes (Weiss 2001, SD units of stdTPI; θ = slope):
 *   ridge        stdTPI >  +1
 *   upper slope  +0.5 < stdTPI ≤ +1
 *   middle slope −0.5 ≤ stdTPI ≤ +0.5 and θ >  5°
 *   flat         −0.5 ≤ stdTPI ≤ +0.5 and θ ≤  5°
 *   lower slope  −1 ≤ stdTPI < −0.5
 *   valley       stdTPI < −1
 *
 * UNITS. TPI is in the grid's Z units (metres in, metres out; feet in,
 * feet out) — it scales linearly with Z. stdTPI and the classes are
 * dimensionless (unit-free). The window radius is in CELLS, not linear
 * units: callers pick the radius against their cell size (radius r at
 * cell size c probes a ~r·c neighbourhood). The neighbourhood is the
 * cells within EUCLIDEAN distance ≤ radiusCells of the centre (a
 * discrete circle), centre excluded.
 *
 * EDGES & NODATA. Cells outside the grid simply do not exist: the window
 * SHRINKS at the border (only in-bounds cells are averaged) and NEVER
 * wraps. Non-finite z (NaN/±Inf — the DTM's honest "no data" state) and
 * cells masked out by an optional validity mask are skipped both as
 * centres (their TPI is NaN) and as neighbours (they never enter a
 * mean). A valid centre whose shrunken window contains no valid
 * neighbour gets TPI NaN — there is no neighbourhood to be positioned
 * against, and we do not invent one.
 *
 * The slope input, when provided for classification, must be the
 * rise/run TANGENT from `hornSlopeAspect` (src/terrain/ground/
 * terrainDerivatives.ts) — the 5° threshold is applied as tan(5°). When
 * no slope grid is supplied the middle/flat split is impossible, so
 * `classes` is null and a warning says why — no silent default.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { quantileSorted } from '../quantile';
import {
  finaliseComplexityEnvelope,
  type ComplexityEnvelope,
  type ComplexityMetaInput,
} from './complexityEnvelope';

/** Slope-position class codes (Weiss 2001). 0 is the explicit no-data state. */
export const TPI_CLASS = {
  nodata: 0,
  valley: 1,
  lower: 2,
  middle: 3,
  flat: 4,
  upper: 5,
  ridge: 6,
} as const;
export type TpiClassName = keyof typeof TPI_CLASS;

/** tan(5°) — the Weiss flat/mid-slope threshold applied to rise/run slope. */
export const TPI_FLAT_SLOPE_TAN = Math.tan((5 * Math.PI) / 180);

/** Options for {@link computeTPI}. */
export interface TpiParams {
  /**
   * Neighbourhood radius in CELLS (Euclidean, centre excluded). Must be a
   * finite value ≥ 1; fractional radii are honoured as-is in the distance
   * test. Invalid values fall back to 1 with a warning.
   */
  readonly radiusCells: number;
  /**
   * Optional per-cell slope as rise/run TANGENT (the `slope` array from
   * `hornSlopeAspect`), row-major, length cols×rows. Required for the
   * flat-vs-middle class split; without it `classes` is null.
   */
  readonly slope?: ArrayLike<number>;
  /**
   * Optional validity mask (nonzero = usable), e.g. `DtmGrid.coverage`.
   * Cells with mask 0 are treated as NoData even if their z is finite,
   * so interpolation-withheld cells never manufacture terrain position.
   */
  readonly valid?: ArrayLike<number>;
  /**
   * Provenance passthrough from the source product (e.g. `DtmGrid`):
   * coverage mode + point counts for the honesty envelope. Omitted →
   * 'full' coverage, 0 points claimed (see complexityEnvelope.ts).
   */
  readonly meta?: ComplexityMetaInput;
}

/**
 * Result of {@link computeTPI}. TPI is in the grid's Z units. Carries the
 * `TerrainCoverageMeta` honesty fields (coverage, source/analyzed point
 * counts, derived 0–100 confidence, ordered warnings) via
 * {@link ComplexityEnvelope}.
 */
export interface TpiResult extends ComplexityEnvelope {
  /** TPI per cell, row-major; NaN where the cell (or its window) is invalid. */
  readonly tpi: Float32Array;
  /** Standardised TPI, (TPI − mean)/stdev over valid cells; NaN invalid. */
  readonly stdTpi: Float32Array;
  /**
   * Slope-position class per cell ({@link TPI_CLASS} codes), or null when no
   * slope grid was supplied (the flat/middle split needs θ).
   */
  readonly classes: Uint8Array | null;
  /** Mean of TPI over valid cells (Z units); NaN when none. */
  readonly mean: number;
  /** Population standard deviation of TPI over valid cells; NaN when none. */
  readonly stdev: number;
  /** Robust summary of the per-cell TPI distribution (Z units). */
  readonly summary: TpiSummary;
  /** Cells whose TPI is finite. */
  readonly validCellCount: number;
  /** Total cells in the grid. */
  readonly cellCount: number;
  /**
   * Valid cells whose window was truncated — by the grid border or by
   * invalid neighbours — i.e. averaged fewer neighbours than a full
   * interior window would.
   */
  readonly truncatedWindowCount: number;
  /**
   * Mean of (valid window members / full window size) over valid cells,
   * in [0, 1] — the data-support term behind `confidence`.
   */
  readonly meanWindowSupport: number;
  /** Ordered caveats (shrunken windows, missing slope, fallbacks…). */
  readonly warnings: ReadonlyArray<string>;
}

/** Median + interquartile range (type-7 quantiles) — never a bare number. */
export interface TpiSummary {
  readonly median: number;
  readonly p25: number;
  readonly p75: number;
  readonly iqr: number;
}

const NO_SUMMARY: TpiSummary = { median: NaN, p25: NaN, p75: NaN, iqr: NaN };

/**
 * Compute TPI, standardised TPI, and (when slope is supplied) the Weiss
 * six-class slope position over a row-major grid. `z` non-finite = NoData.
 */
export function computeTPI(
  z: ArrayLike<number>,
  cols: number,
  rows: number,
  params: TpiParams,
): TpiResult {
  const warnings: string[] = [];
  const n = cols > 0 && rows > 0 ? cols * rows : 0;
  const tpi = new Float32Array(n).fill(NaN);
  const stdTpi = new Float32Array(n).fill(NaN);

  let radius = params.radiusCells;
  if (!Number.isFinite(radius) || radius < 1) {
    warnings.push(`radiusCells invalid (${String(params.radiusCells)}); using 1`);
    radius = 1;
  }

  if (n === 0 || z.length < n) {
    if (z.length < n) warnings.push('z shorter than cols×rows — no cells analysed');
    warnings.push('empty grid — no TPI computed');
    return emptyResult(tpi, stdTpi, n, warnings, params.slope != null, params.meta);
  }

  const valid = params.valid;
  const isValid = (i: number): boolean =>
    (valid == null || valid[i] !== 0) && Number.isFinite(z[i]);

  // Precompute the window offsets for the discrete circle (centre excluded).
  const rCeil = Math.ceil(radius);
  const r2 = radius * radius;
  const offsets: Array<readonly [number, number]> = [];
  for (let dr = -rCeil; dr <= rCeil; dr++) {
    for (let dc = -rCeil; dc <= rCeil; dc++) {
      if (dr === 0 && dc === 0) continue;
      if (dr * dr + dc * dc <= r2) offsets.push([dr, dc]);
    }
  }
  const fullWindow = offsets.length;

  // Pass 1 — TPI per cell (float64 accumulation for the window mean).
  let validCellCount = 0;
  let truncatedWindowCount = 0;
  let supportSum = 0; // Σ (count / fullWindow) over valid cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!isValid(i)) continue; // NoData centre → TPI stays NaN
      let sum = 0;
      let count = 0;
      for (const [dr, dc] of offsets) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= rows || c < 0 || c >= cols) continue; // shrink, never wrap
        const j = r * cols + c;
        if (!isValid(j)) continue; // NoData neighbour skipped
        sum += z[j];
        count++;
      }
      if (count === 0) continue; // no neighbourhood → honest NaN
      if (count < fullWindow) truncatedWindowCount++;
      supportSum += count / fullWindow;
      tpi[i] = z[i] - sum / count;
      validCellCount++;
    }
  }

  if (validCellCount === 0) {
    warnings.push('no valid cells — TPI undefined everywhere');
    return emptyResult(tpi, stdTpi, n, warnings, params.slope != null, params.meta);
  }

  // Pass 2 — mean/stdev over valid TPI cells (population stdev), then
  // standardise. stdev 0 (e.g. a perfect plane) standardises to 0, not NaN:
  // every cell sits exactly at the neighbourhood mean.
  let sum = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(tpi[i])) sum += tpi[i];
  const mean = sum / validCellCount;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(tpi[i])) {
      const d = tpi[i] - mean;
      sq += d * d;
    }
  }
  const stdev = Math.sqrt(sq / validCellCount);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(tpi[i])) stdTpi[i] = stdev > 0 ? (tpi[i] - mean) / stdev : 0;
  }

  // Pass 3 — classes (only when slope is available; no silent default).
  let classes: Uint8Array | null = null;
  const slope = params.slope;
  if (slope != null && slope.length >= n) {
    classes = new Uint8Array(n); // 0 = nodata
    for (let i = 0; i < n; i++) {
      const s = stdTpi[i];
      if (!Number.isFinite(s)) continue;
      const sl = slope[i];
      classes[i] = classify(s, Number.isFinite(sl) ? sl : 0);
    }
  } else if (slope != null) {
    warnings.push('slope grid shorter than cols×rows — slope-position classes not derived');
  } else {
    warnings.push('no slope grid supplied — flat/middle split needs θ; classes not derived');
  }

  if (truncatedWindowCount > 0) {
    warnings.push(
      `${truncatedWindowCount} of ${validCellCount} windows truncated at grid border or NoData — edge TPI is derived from a shrunken neighbourhood`,
    );
  }

  const meanWindowSupport = supportSum / validCellCount;
  const envelope = finaliseComplexityEnvelope(
    { cellCount: n, validCellCount, meanWindowSupport },
    params.meta,
    warnings,
  );

  return {
    ...envelope,
    tpi,
    stdTpi,
    classes,
    mean,
    stdev,
    summary: summarise(tpi, validCellCount),
    validCellCount,
    cellCount: n,
    truncatedWindowCount,
    meanWindowSupport,
    warnings,
  };
}

/** Weiss (2001) six-class slope position from stdTPI + rise/run slope. */
function classify(stdTpi: number, slopeTan: number): number {
  if (stdTpi > 1) return TPI_CLASS.ridge;
  if (stdTpi > 0.5) return TPI_CLASS.upper;
  if (stdTpi >= -0.5) return slopeTan > TPI_FLAT_SLOPE_TAN ? TPI_CLASS.middle : TPI_CLASS.flat;
  if (stdTpi >= -1) return TPI_CLASS.lower;
  return TPI_CLASS.valley;
}

function summarise(values: Float32Array, validCount: number): TpiSummary {
  if (validCount === 0) return NO_SUMMARY;
  const finite: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (Number.isFinite(values[i])) finite.push(values[i]);
  }
  finite.sort((a, b) => a - b);
  const p25 = quantileSorted(finite, 0.25);
  const p75 = quantileSorted(finite, 0.75);
  return { median: quantileSorted(finite, 0.5), p25, p75, iqr: p75 - p25 };
}

function emptyResult(
  tpi: Float32Array,
  stdTpi: Float32Array,
  cellCount: number,
  warnings: string[],
  slopeSupplied: boolean,
  meta: ComplexityMetaInput | undefined,
): TpiResult {
  const envelope = finaliseComplexityEnvelope(
    { cellCount, validCellCount: 0, meanWindowSupport: 0 },
    meta,
    warnings,
  );
  return {
    ...envelope,
    tpi,
    stdTpi,
    classes: slopeSupplied ? new Uint8Array(cellCount) : null,
    mean: NaN,
    stdev: NaN,
    summary: NO_SUMMARY,
    validCellCount: 0,
    cellCount,
    truncatedWindowCount: 0,
    meanWindowSupport: 0,
    warnings,
  };
}
