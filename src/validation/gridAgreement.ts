/**
 * gridAgreement.ts
 *
 * Cell-by-cell comparison of two rasters that are supposed to describe the same
 * ground.
 *
 * Three rules carry the module, and they matter more than the statistics.
 *
 * A comparison that is not aligned is refused, not repaired. If the origins,
 * dimensions or cell sizes disagree, the honest answer is "these two grids do
 * not describe the same cells", and the refusal is a typed result so a caller
 * has to handle it. Resampling one side to fit the other would produce a number,
 * and that number would describe the resampler as much as the data.
 *
 * A missing measurement is `null`, never `0`. Zero is a legitimate error value,
 * so a comparison that writes `0` for "there was nothing to measure" makes an
 * absent result indistinguishable from a perfect one. An empty overlap is a
 * refusal for the same reason.
 *
 * Mask agreement is reported apart from value agreement. Two grids can agree
 * closely on every cell they both fill while disagreeing about which cells are
 * fillable at all, and pooling those into one figure hides the second problem.
 *
 * Pure arithmetic over plain arrays and typed arrays. No I/O, no DOM. Nothing
 * here validates any product; it only compares two arrays the caller supplies.
 */

/** Grid geometry. Two rasters are comparable only when all five agree. */
export interface GridSpec {
  readonly originX: number;
  readonly originY: number;
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
}

/** Row-major cell values. Typed arrays are accepted as-is, never copied. */
export type NumericGrid = readonly number[] | Float32Array | Float64Array;

/** A cell is empty when it is non-finite or equal to the nodata sentinel. */
export interface Raster {
  readonly spec: GridSpec;
  readonly values: NumericGrid;
  /** Sentinel for an empty cell, or null when only non-finite counts as empty. */
  readonly nodata: number | null;
}

/** true (or 1) where a cell was interpolated rather than measured. */
export type InterpolatedMask = readonly boolean[] | Uint8Array;

export interface GridCompareOptions {
  /** Absolute error a cell may carry and still count as within tolerance. */
  readonly tolerance: number;
  readonly interpolatedMask?: InterpolatedMask;
  /** Refuse a comparison with fewer comparable cells than this. Default 1. */
  readonly minCells?: number;
}

/**
 * How far two origins or cell sizes may differ and still count as the same grid.
 *
 * This is a float-representation allowance, not a resampling allowance: a grid
 * written as 0.5 and read back as 0.49999999999999994 is the same grid, while
 * one shifted by a millimetre is not, and the constant is frozen here so it
 * cannot be widened after seeing which side of it a comparison fell.
 */
export const GRID_ALIGNMENT_EPSILON = 1e-9;

/** Why a comparison was refused. */
export type GridRefusalReason =
  | 'grid-origin-differs'
  | 'grid-cell-size-differs'
  | 'grid-dimensions-differ'
  | 'invalid-grid'
  | 'value-count-mismatch'
  | 'mask-length-mismatch'
  | 'invalid-tolerance'
  | 'invalid-min-cells'
  | 'no-comparable-cells'
  | 'below-min-cells'
  | 'slope-count-mismatch'
  | 'invalid-min-slope';

export interface GridRefusal {
  readonly status: 'refused';
  readonly reason: GridRefusalReason;
  /** Human-readable specifics, including the numbers that failed the check. */
  readonly detail: string;
}

/**
 * Error statistics over one set of cells.
 *
 * Every field is nullable and every one is `null` together when `n` is 0, so a
 * reader never has to guess whether a zero is a measurement.
 *
 * Quantiles are nearest-rank: each reported value is an error some cell
 * actually had, rather than an interpolation between two cells.
 */
export interface ErrorStats {
  readonly n: number;
  readonly meanSignedError: number | null;
  readonly medianSignedError: number | null;
  readonly rmse: number | null;
  readonly nmad: number | null;
  readonly mae: number | null;
  readonly p50AbsError: number | null;
  readonly p90AbsError: number | null;
  readonly p95AbsError: number | null;
  readonly p99AbsError: number | null;
  readonly maxAbsError: number | null;
  readonly withinToleranceFraction: number | null;
}

/** Agreement about WHICH cells hold data, kept apart from the values. */
export interface MaskAgreement {
  readonly cells: number;
  readonly bothValid: number;
  readonly bothNodata: number;
  /** Valid in A, nodata in B. */
  readonly onlyA: number;
  /** Valid in B, nodata in A. */
  readonly onlyB: number;
  /** (bothValid + bothNodata) / cells, or null for a zero-cell grid. */
  readonly agreementFraction: number | null;
}

export interface GridAgreement {
  readonly status: 'compared';
  readonly cells: number;
  readonly tolerance: number;
  readonly mask: MaskAgreement;
  /** Over every cell valid on both sides. */
  readonly value: ErrorStats;
  /** Measured cells only. null when the caller supplied no mask. */
  readonly covered: ErrorStats | null;
  /** Interpolated cells only. null when the caller supplied no mask. */
  readonly interpolated: ErrorStats | null;
}

export type GridComparison = GridAgreement | GridRefusal;

/** Slope raster used to exclude cells where aspect is undefined. */
export interface SlopeGate {
  readonly values: NumericGrid;
  /** Cells strictly below this slope are excluded and reported separately. */
  readonly minSlope: number;
  readonly nodata?: number | null;
}

export interface CircularCompareOptions extends GridCompareOptions {
  readonly slopeGate?: SlopeGate;
}

export interface CircularGridAgreement extends GridAgreement {
  /** Cells excluded because slope fell below the gate. */
  readonly flatExcluded: number;
  /**
   * The excluded cells measured anyway, so a reader can see whether the flat
   * ground merely disagreed or disagreed wildly. Never pooled into `value`.
   */
  readonly flat: ErrorStats | null;
  readonly minSlope: number | null;
}

export type CircularGridComparison = CircularGridAgreement | GridRefusal;

function refuse(reason: GridRefusalReason, detail: string): GridRefusal {
  return { status: 'refused', reason, detail };
}

function cellCount(spec: GridSpec): number {
  return spec.width * spec.height;
}

function maskAt(mask: InterpolatedMask, i: number): boolean {
  // A Uint8Array mask is the shape a worker or a WASM pass hands back; treat
  // any non-zero as "interpolated" rather than requiring exactly 1.
  return mask instanceof Uint8Array ? mask[i] !== 0 : mask[i] === true;
}

function isEmptyCell(v: number, nodata: number | null): boolean {
  if (!Number.isFinite(v)) return true;
  return nodata !== null && v === nodata;
}

/** Nearest-rank quantile over an ascending copy. `p` is a fraction in [0,1]. */
function quantileSorted(sorted: readonly number[], p: number): number {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Statistics over a set of signed errors.
 *
 * Signed mean and median come first because they expose a systematic offset
 * that RMSE and MAE cannot show, and NMAD sits next to RMSE because raster
 * error distributions are rarely normal.
 */
function statsOf(signed: readonly number[], tolerance: number): ErrorStats {
  const n = signed.length;
  if (n === 0) {
    return {
      n: 0,
      meanSignedError: null,
      medianSignedError: null,
      rmse: null,
      nmad: null,
      mae: null,
      p50AbsError: null,
      p90AbsError: null,
      p95AbsError: null,
      p99AbsError: null,
      maxAbsError: null,
      withinToleranceFraction: null,
    };
  }
  let sum = 0;
  let sumSq = 0;
  let sumAbs = 0;
  let within = 0;
  const abs: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = signed[i];
    const a = Math.abs(d);
    sum += d;
    sumSq += d * d;
    sumAbs += a;
    if (a <= tolerance) within++;
    abs.push(a);
  }
  const sortedSigned = [...signed].sort((x, y) => x - y);
  const sortedAbs = abs.sort((x, y) => x - y);
  const median = quantileSorted(sortedSigned, 0.5);
  // NMAD = 1.4826 × median(|x − median(x)|). The constant makes it a consistent
  // estimator of the standard deviation under normality while staying resistant
  // to the blunders that inflate RMSE.
  const dev = signed.map((d) => Math.abs(d - median)).sort((x, y) => x - y);
  return {
    n,
    meanSignedError: sum / n,
    medianSignedError: median,
    rmse: Math.sqrt(sumSq / n),
    nmad: 1.4826 * quantileSorted(dev, 0.5),
    mae: sumAbs / n,
    p50AbsError: quantileSorted(sortedAbs, 0.5),
    p90AbsError: quantileSorted(sortedAbs, 0.9),
    p95AbsError: quantileSorted(sortedAbs, 0.95),
    p99AbsError: quantileSorted(sortedAbs, 0.99),
    maxAbsError: sortedAbs[sortedAbs.length - 1],
    withinToleranceFraction: within / n,
  };
}

/** Checks common to both entry points. Returns a refusal or null. */
function preflight(
  a: Raster,
  b: Raster,
  options: GridCompareOptions,
): GridRefusal | null {
  const { tolerance } = options;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    return refuse('invalid-tolerance', `tolerance must be finite and >= 0, got ${tolerance}`);
  }
  const minCells = options.minCells ?? 1;
  if (!Number.isInteger(minCells) || minCells < 1) {
    return refuse('invalid-min-cells', `minCells must be an integer >= 1, got ${minCells}`);
  }
  for (const [name, spec] of [
    ['a', a.spec],
    ['b', b.spec],
  ] as const) {
    if (
      !Number.isInteger(spec.width) ||
      !Number.isInteger(spec.height) ||
      spec.width < 1 ||
      spec.height < 1 ||
      !Number.isFinite(spec.cellSize) ||
      spec.cellSize <= 0 ||
      !Number.isFinite(spec.originX) ||
      !Number.isFinite(spec.originY)
    ) {
      return refuse(
        'invalid-grid',
        `raster ${name} has an unusable spec: ${spec.width}x${spec.height} @ ${spec.cellSize}`,
      );
    }
  }
  if (a.spec.width !== b.spec.width || a.spec.height !== b.spec.height) {
    return refuse(
      'grid-dimensions-differ',
      `${a.spec.width}x${a.spec.height} vs ${b.spec.width}x${b.spec.height}; ` +
        'no resample is performed',
    );
  }
  if (Math.abs(a.spec.cellSize - b.spec.cellSize) > GRID_ALIGNMENT_EPSILON) {
    return refuse(
      'grid-cell-size-differs',
      `cell size ${a.spec.cellSize} vs ${b.spec.cellSize}; no resample is performed`,
    );
  }
  if (
    Math.abs(a.spec.originX - b.spec.originX) > GRID_ALIGNMENT_EPSILON ||
    Math.abs(a.spec.originY - b.spec.originY) > GRID_ALIGNMENT_EPSILON
  ) {
    return refuse(
      'grid-origin-differs',
      `origin (${a.spec.originX}, ${a.spec.originY}) vs ` +
        `(${b.spec.originX}, ${b.spec.originY}); no shift is applied`,
    );
  }
  const cells = cellCount(a.spec);
  if (a.values.length !== cells || b.values.length !== cells) {
    return refuse(
      'value-count-mismatch',
      `spec declares ${cells} cells, arrays hold ${a.values.length} and ${b.values.length}`,
    );
  }
  if (options.interpolatedMask && options.interpolatedMask.length !== cells) {
    return refuse(
      'mask-length-mismatch',
      `interpolated mask holds ${options.interpolatedMask.length} entries, grid has ${cells}`,
    );
  }
  return null;
}

/** Signed difference collector shared by the linear and circular paths. */
interface Buckets {
  readonly all: number[];
  readonly covered: number[];
  readonly interpolated: number[];
  readonly flat: number[];
}

function emptyBuckets(): Buckets {
  return { all: [], covered: [], interpolated: [], flat: [] };
}

function tallyMask(a: Raster, b: Raster, cells: number): MaskAgreement {
  let bothValid = 0;
  let bothNodata = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < cells; i++) {
    const ea = isEmptyCell(a.values[i], a.nodata);
    const eb = isEmptyCell(b.values[i], b.nodata);
    if (!ea && !eb) bothValid++;
    else if (ea && eb) bothNodata++;
    else if (eb) onlyA++;
    else onlyB++;
  }
  return {
    cells,
    bothValid,
    bothNodata,
    onlyA,
    onlyB,
    agreementFraction: cells === 0 ? null : (bothValid + bothNodata) / cells,
  };
}

/**
 * Compare two rasters cell by cell on a linear quantity (elevation, slope,
 * intensity). Aspect must use `compareGridsCircular` instead.
 */
export function compareGrids(
  a: Raster,
  b: Raster,
  options: GridCompareOptions,
): GridComparison {
  const bad = preflight(a, b, options);
  if (bad) return bad;

  const cells = cellCount(a.spec);
  const mask = tallyMask(a, b, cells);
  const buckets = emptyBuckets();
  const im = options.interpolatedMask;
  for (let i = 0; i < cells; i++) {
    const va = a.values[i];
    const vb = b.values[i];
    if (isEmptyCell(va, a.nodata) || isEmptyCell(vb, b.nodata)) continue;
    const d = va - vb;
    buckets.all.push(d);
    if (im) {
      if (maskAt(im, i)) buckets.interpolated.push(d);
      else buckets.covered.push(d);
    }
  }
  return finish(buckets, mask, options, cells, null);
}

/**
 * Signed angular separation in degrees, wrapped into (-180, 180].
 *
 * Aspect is a direction, so plain subtraction is wrong at the wrap: 359° and 1°
 * are 2° apart, not 358°. Sign is kept so a systematic rotation between two
 * implementations still shows up as a non-zero mean.
 */
export function signedAngularDifferenceDeg(a: number, b: number): number {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  // The expression above maps an exact 180 to -180; report +180 so the
  // magnitude is right and the sign convention stays "a minus b".
  return d === -180 ? 180 : d;
}

/** Absolute angular separation in degrees, in [0, 180]. */
export function angularSeparationDeg(a: number, b: number): number {
  return Math.abs(signedAngularDifferenceDeg(a, b));
}

/**
 * Compare two aspect rasters, wrapping at 360°.
 *
 * Cells whose slope falls below `slopeGate.minSlope` are excluded from the
 * headline statistics and reported separately, because aspect is undefined on
 * flat ground: two implementations can disagree by 180° there without either
 * being wrong.
 */
export function compareGridsCircular(
  a: Raster,
  b: Raster,
  options: CircularCompareOptions,
): CircularGridComparison {
  const bad = preflight(a, b, options);
  if (bad) return bad;

  const cells = cellCount(a.spec);
  const gate = options.slopeGate;
  if (gate) {
    if (gate.values.length !== cells) {
      return refuse(
        'slope-count-mismatch',
        `slope gate holds ${gate.values.length} cells, grid has ${cells}`,
      );
    }
    if (!Number.isFinite(gate.minSlope) || gate.minSlope < 0) {
      return refuse(
        'invalid-min-slope',
        `minSlope must be finite and >= 0, got ${gate.minSlope}`,
      );
    }
  }

  const mask = tallyMask(a, b, cells);
  const buckets = emptyBuckets();
  const im = options.interpolatedMask;
  for (let i = 0; i < cells; i++) {
    const va = a.values[i];
    const vb = b.values[i];
    if (isEmptyCell(va, a.nodata) || isEmptyCell(vb, b.nodata)) continue;
    const d = signedAngularDifferenceDeg(va, vb);
    if (gate) {
      const s = gate.values[i];
      // A cell with no slope reading cannot be shown to be steep enough, so it
      // is excluded rather than assumed usable.
      if (isEmptyCell(s, gate.nodata ?? null) || s < gate.minSlope) {
        buckets.flat.push(d);
        continue;
      }
    }
    buckets.all.push(d);
    if (im) {
      if (maskAt(im, i)) buckets.interpolated.push(d);
      else buckets.covered.push(d);
    }
  }
  return finish(buckets, mask, options, cells, gate ? gate.minSlope : null);
}

/** Shared tail: apply the empty/min-cells refusals, then build the result. */
function finish(
  buckets: Buckets,
  mask: MaskAgreement,
  options: GridCompareOptions,
  cells: number,
  minSlope: number | null,
): CircularGridComparison {
  const minCells = options.minCells ?? 1;
  const n = buckets.all.length;
  if (n === 0) {
    const because =
      buckets.flat.length > 0
        ? `all ${buckets.flat.length} comparable cells fell below the ` +
          `${String(minSlope)} slope gate`
        : 'no cell holds a value on both sides';
    return refuse('no-comparable-cells', `${because}; a zero-cell comparison is not reported`);
  }
  if (n < minCells) {
    return refuse('below-min-cells', `${n} comparable cells, ${minCells} required`);
  }
  const tol = options.tolerance;
  const hasMask = options.interpolatedMask !== undefined;
  return {
    status: 'compared',
    cells,
    tolerance: tol,
    mask,
    value: statsOf(buckets.all, tol),
    covered: hasMask ? statsOf(buckets.covered, tol) : null,
    interpolated: hasMask ? statsOf(buckets.interpolated, tol) : null,
    flatExcluded: buckets.flat.length,
    flat: buckets.flat.length > 0 ? statsOf(buckets.flat, tol) : null,
    minSlope,
  };
}
