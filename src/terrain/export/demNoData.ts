/**
 * demNoData.ts
 *
 * The NoData sentinel for the DEM rasters, chosen so that no written height
 * equals it.
 *
 * A reader compares each sample with the declared NoData value after the
 * sample has been written: as a float32 in the GeoTIFF, and as decimal text
 * with a fixed number of places in the ASCII grid. A covered height of -9999,
 * or one that rounds to it (-9998.9996 in float32, -9999.0003 at three
 * places), was therefore read as missing under the fixed -9999 sentinel. Deep
 * bathymetry in feet reaches that depth.
 *
 * -9999 stays the sentinel whenever nothing collides, so ordinary files keep
 * their bytes. Otherwise the sentinel moves below every written value.
 *
 * Pure-data: no DOM, deterministic.
 */

/** The sentinel written when no height collides with it. */
export const DEFAULT_NO_DATA = -9999;

/** The most negative finite float32. */
const MOST_NEGATIVE_FLOAT32 = -3.4028234663852886e38;

/** Integers up to 2^24 are exact in float32. */
const FLOAT32_EXACT_INTEGER = 2 ** 24;

/** How a value is written: as a float32 sample, or as decimal text. */
export type NoDataSerialisation = 'float32' | 'ascii';

/** Thrown when a caller-given NoData value equals a written height. */
export class NoDataCollisionError extends Error {
  readonly noData: number;
  readonly value: number;
  constructor(noData: number, value: number) {
    super(
      `NoData value ${noData} equals a written height (${value}), so a reader would take that cell as missing`,
    );
    this.name = 'NoDataCollisionError';
    this.noData = noData;
    this.value = value;
  }
}

/** One grid the sentinel is shared with. Cells with coverage 0 are NoData already. */
export interface NoDataGrid {
  readonly values: ArrayLike<number>;
  readonly coverage: ArrayLike<number>;
}

export interface NoDataOptions {
  /** The serialisations the sentinel must survive. Default both. */
  readonly serialisations?: readonly NoDataSerialisation[];
  /** Decimal places of the ASCII grid. Default 3. */
  readonly precision?: number;
}

/** Whether `value`, written as `how`, reads back equal to `noData`. */
export function collidesWithNoData(
  value: number,
  noData: number,
  how: NoDataSerialisation,
  precision = 3,
): boolean {
  if (!Number.isFinite(value)) return false;
  if (how === 'float32') return Math.fround(value) === Math.fround(noData);
  return Number(value.toFixed(precision)) === noData;
}

/** The first covered value that collides with `noData`, or null. */
export function findNoDataCollision(
  grids: readonly NoDataGrid[],
  noData: number,
  opts: NoDataOptions = {},
): number | null {
  const how = opts.serialisations ?? ['float32', 'ascii'];
  const precision = opts.precision ?? 3;
  for (const g of grids) {
    for (let i = 0; i < g.values.length; i++) {
      if (g.coverage[i] === 0) continue;
      const v = g.values[i];
      for (const h of how) if (collidesWithNoData(v, noData, h, precision)) return v;
    }
  }
  return null;
}

/**
 * The NoData value for a set of grids that share one declaration: -9999 when
 * no covered value collides with it, else the first of -99999, -999999,
 * -9999999 below every written value, else the most negative float32.
 * Throws {@link NoDataCollisionError} if even that collides.
 */
export function chooseNoData(grids: readonly NoDataGrid[], opts: NoDataOptions = {}): number {
  if (findNoDataCollision(grids, DEFAULT_NO_DATA, opts) == null) return DEFAULT_NO_DATA;
  let min = Infinity;
  for (const g of grids) {
    for (let i = 0; i < g.values.length; i++) {
      const v = g.values[i];
      if (g.coverage[i] !== 0 && Number.isFinite(v)) min = Math.min(min, Math.fround(v), v);
    }
  }
  const candidates: number[] = [];
  for (let k = 5; 10 ** k - 1 < FLOAT32_EXACT_INTEGER; k++) {
    const c = -(10 ** k - 1);
    if (c < min - 1) candidates.push(c);
  }
  candidates.push(MOST_NEGATIVE_FLOAT32);
  for (const c of candidates) if (findNoDataCollision(grids, c, opts) == null) return c;
  throw new NoDataCollisionError(MOST_NEGATIVE_FLOAT32, MOST_NEGATIVE_FLOAT32);
}

/** Throw {@link NoDataCollisionError} when a caller-given sentinel collides. */
export function assertNoDataClear(grids: readonly NoDataGrid[], noData: number, opts: NoDataOptions = {}): void {
  const hit = findNoDataCollision(grids, noData, opts);
  if (hit != null) throw new NoDataCollisionError(noData, hit);
}
