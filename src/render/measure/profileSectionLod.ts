/**
 * profileSectionLod.ts
 *
 * Pick which of a profile section's accepted returns the section view draws.
 *
 * A corridor can accept millions of returns while the renderer holds a fixed
 * display budget, so what is drawn is a sample of the section rather than the
 * section itself. The section arrays are the record and stay whole: this
 * returns indices into them, reads nothing else and writes nothing back.
 *
 * Three things a section view has to keep that a proportional sample does
 * not.
 *
 * A thin dense stratum. Ground returns occupy a band a few centimetres thick
 * under a canopy tens of metres deep. By count the band is a small minority,
 * so a sample drawn in proportion to count leaves a sparse dusting where the
 * ground line should be. Sampling is stratified on a grid laid over chainage
 * and height instead, which spends the budget per occupied region of the
 * section rather than per return, and the band is a region.
 *
 * A rare class or a rare source. A hundred returns of a class that matters,
 * or the second scan in a two-scan comparison, round to nothing against a
 * million. Each (source slot, classification) pair is a stratum of its own and
 * holds a floor of the budget before the grid fill starts.
 *
 * Input order. Returns arrive grouped by source, so anything that reads a
 * prefix, or that walks strata in the order they were first encountered,
 * shows whichever source was scanned first. Strata are walked in an order
 * derived from their position in the section, and within a stratum returns are
 * taken in ascending index, so permuting the input leaves the count drawn from
 * every stratum unchanged.
 *
 * Selection is a pure function of the section's values and the cap. No
 * randomness is involved and no iteration order of a hash container reaches
 * the result.
 */

/**
 * The part of a section this reads.
 *
 * A `ProfileSectionPoints` satisfies it. `classification` is absent when no
 * source carried the channel; where a source that carries it is mixed with one
 * that does not, the returns of the second carry class 0, which is `never
 * classified` and forms a stratum of its own.
 */
export interface ProfileSectionLodInput {
  readonly count: number;
  readonly chainage: Float32Array;
  readonly height: Float64Array;
  readonly sourceSlot: Uint16Array;
  readonly classification?: Uint8Array;
}

export interface ProfileSectionLodOptions {
  /** Most returns the view will draw. */
  readonly cap: number;
  /**
   * Indices that appear in the result whatever the cap.
   *
   * The selected or hovered return is addressed by index, so dropping it
   * would make the view disagree with the readout. Keeps count against the
   * cap; a keep set larger than the cap is emitted whole and is the only case
   * where the result is longer than the cap.
   */
  readonly keep?: ArrayLike<number> | null;
}

/** The chainage x height grid the strata sit on. */
export interface ProfileSectionLodGrid {
  readonly nx: number;
  readonly ny: number;
  readonly minChainage: number;
  readonly maxChainage: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * Height range the grid rows span, as a fraction trimmed from each tail.
 *
 * A single stray return - a bird, a cloud return, a blunder - carries the raw
 * height range far past the section. Cells are square, so that stretches the
 * chainage axis with it and the section collapses into a handful of columns.
 * Measured on a 400k return section, canopy 2 m to 22 m over 200 m of
 * chainage, cap 5000: adding one return at 10 km takes the untrimmed grid
 * from 213 columns x 23 rows of 0.96 m to 10 columns x 500 rows of 20 m,
 * which leaves the ground band sharing one row with the whole canopy and the
 * drawn ground line reduced to 10 clumps. Trimming 0.5 % of the mass from
 * each tail holds it at 185 columns x 27 rows of 1.09 m. The tail is 0.5 %
 * rather than tighter because a genuine ground band can be a few per cent of
 * the returns and sits in the bottom tail; returns outside the trimmed range
 * are clamped into the edge rows, so the trim sets the grid's resolution and
 * never a return's eligibility.
 */
const HEIGHT_TRIM = 0.005;

/**
 * Bins in the histogram the trimmed height range is read from.
 *
 * The trimmed edge lands on a bin boundary, so the bin width is the error.
 * On the 10 km outlier section the bins are 9.8 m wide and the trimmed top
 * comes out at 29.3 m against a true canopy top of 22 m, one bin of
 * overshoot, which costs 4 of the 27 rows. Halving the bin width would
 * recover them; 1024 keeps the histogram at 4 kB and the overshoot at one bin
 * of the raw extent.
 */
const TRIM_BINS = 1024;

/**
 * Share of the cap reserved for per-stratum floors.
 *
 * Measured on the canopy-over-ground section at a cap of 5000: the ground
 * band holds 5 % of the returns, so a sample drawn in proportion to count
 * draws 250 of them, too few to read as a line. A quarter of the cap split
 * across the two strata present reserves 625 for the band and the grid fill
 * carries it to 800, while three quarters of the display stays spent in
 * proportion to where the section actually has returns.
 */
const FLOOR_SHARE = 0.25;

/**
 * Most cells on one grid axis, and most cells overall.
 *
 * The grid is sized from the cap, so these only bound what a caller asking
 * for an implausible cap can allocate: one map entry and one order record per
 * occupied cell, about 100 bytes, so 262144 cells is a 25 MB ceiling. Neither
 * bound reaches a plausible section view. 4096 columns across a 200 m section
 * are 4.9 cm apart, finer than the return spacing of any airborne survey, and
 * a display budget of a quarter of a million returns is already past what the
 * section view draws.
 */
const MAX_AXIS = 4096;
const MAX_CELLS = 262144;

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/** Smallest and largest finite entry, or `null` when there is none. */
function finiteRange(values: ArrayLike<number>, n: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Range left after `HEIGHT_TRIM` of the returns is dropped from each tail. */
function trimmedRange(
  values: ArrayLike<number>,
  n: number,
  lo: number,
  hi: number,
): [number, number] {
  const span = hi - lo;
  if (!(span > 0)) return [lo, hi];
  const hist = new Uint32Array(TRIM_BINS);
  const scale = TRIM_BINS / span;
  let counted = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    const b = Math.min(TRIM_BINS - 1, Math.max(0, Math.floor((v - lo) * scale)));
    hist[b]! += 1;
    counted++;
  }
  if (counted === 0) return [lo, hi];
  const drop = counted * HEIGHT_TRIM;
  let loBin = 0;
  let below = 0;
  while (loBin < TRIM_BINS - 1 && below + hist[loBin]! <= drop) {
    below += hist[loBin]!;
    loBin++;
  }
  let hiBin = TRIM_BINS - 1;
  let above = 0;
  while (hiBin > loBin && above + hist[hiBin]! <= drop) {
    above += hist[hiBin]!;
    hiBin--;
  }
  const step = span / TRIM_BINS;
  return [lo + loBin * step, lo + (hiBin + 1) * step];
}

/**
 * Lay out the grid the strata sit on.
 *
 * Cells are square in section units so a metre of chainage and a metre of
 * height are stratified alike, and there are about `cap` of them so one
 * return per occupied cell roughly spends the budget. A degenerate axis
 * collapses to a single column or row rather than to a zero-width cell.
 */
export function profileSectionLodGrid(
  points: ProfileSectionLodInput,
  cap: number,
): ProfileSectionLodGrid {
  const n = Math.max(0, Math.min(points.count, points.chainage.length, points.height.length));
  const xr = finiteRange(points.chainage, n) ?? [0, 0];
  const rawY = finiteRange(points.height, n) ?? [0, 0];
  const yr = trimmedRange(points.height, n, rawY[0], rawY[1]);

  const cells = clampInt(Math.max(1, cap), 1, MAX_CELLS);
  const spanX = xr[1] - xr[0];
  const spanY = yr[1] - yr[0];

  let nx: number;
  let ny: number;
  if (spanX > 0 && spanY > 0) {
    nx = clampInt(Math.sqrt((cells * spanX) / spanY), 1, MAX_AXIS);
    ny = clampInt(cells / nx, 1, MAX_AXIS);
  } else if (spanX > 0) {
    nx = clampInt(cells, 1, MAX_AXIS);
    ny = 1;
  } else if (spanY > 0) {
    nx = 1;
    ny = clampInt(cells, 1, MAX_AXIS);
  } else {
    nx = 1;
    ny = 1;
  }
  return {
    nx,
    ny,
    minChainage: xr[0],
    maxChainage: xr[1],
    minHeight: yr[0],
    maxHeight: yr[1],
  };
}

function axisBin(v: number, lo: number, hi: number, n: number): number {
  if (n <= 1 || !Number.isFinite(v) || !(hi > lo)) return 0;
  const b = Math.floor(((v - lo) / (hi - lo)) * n);
  return Math.min(n - 1, Math.max(0, b));
}

/** Cell a section coordinate falls in, as a row-major index into the grid. */
export function profileSectionLodCell(
  grid: ProfileSectionLodGrid,
  chainage: number,
  height: number,
): number {
  const ix = axisBin(chainage, grid.minChainage, grid.maxChainage, grid.nx);
  const iy = axisBin(height, grid.minHeight, grid.maxHeight, grid.ny);
  return iy * grid.nx + ix;
}

/** Bits needed to address `n` values. */
function bitsFor(n: number): number {
  let b = 0;
  while (2 ** b < n) b++;
  return b;
}

/** `v` with its low `bits` bits in the opposite order. */
function reverseBits(v: number, bits: number): number {
  let out = 0;
  let rest = v;
  for (let i = 0; i < bits; i++) {
    out = out * 2 + (rest % 2);
    rest = Math.floor(rest / 2);
  }
  return out;
}

/**
 * Sort key that walks the grid spread out rather than row by row.
 *
 * Row-major order spends the budget on low chainage first, the same bias as
 * reading a prefix of the input. Interleaving the bit-reversed cell
 * coordinates visits one corner, then the opposite one, then the quarter
 * points, so any prefix of the walk already covers the whole section and a
 * budget that runs out mid-walk thins the display evenly instead of clipping
 * one end of it.
 */
function spreadKey(ix: number, iy: number, bitsX: number, bitsY: number): number {
  const rx = reverseBits(ix, bitsX);
  const ry = reverseBits(iy, bitsY);
  const bits = Math.max(bitsX, bitsY);
  let key = 0;
  for (let i = bits - 1; i >= 0; i--) {
    const p = 2 ** i;
    key = key * 2 + (i < bitsX ? Math.floor(rx / p) % 2 : 0);
    key = key * 2 + (i < bitsY ? Math.floor(ry / p) % 2 : 0);
  }
  return key;
}

/** One flag per return, set for every `keep` entry that addresses one. */
function forcedFlags(keep: ArrayLike<number> | null | undefined, n: number): Uint8Array {
  const flags = new Uint8Array(n);
  if (!keep) return flags;
  for (let k = 0; k < keep.length; k++) {
    const i = keep[k]!;
    if (Number.isInteger(i) && i >= 0 && i < n) flags[i] = 1;
  }
  return flags;
}

function flaggedIndices(flags: Uint8Array, n: number, total: number): Uint32Array {
  const out = new Uint32Array(total);
  let w = 0;
  for (let i = 0; i < n; i++) if (flags[i] === 1) out[w++] = i;
  return out;
}

function ascendingRun(n: number): Uint32Array {
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

/**
 * Choose at most `cap` returns to draw, as ascending indices into `points`.
 *
 * The result is a pure function of the section's values, the cap and the keep
 * set. `points` is never written.
 *
 * Below the cap every return is drawn. Above it the budget is spent in three
 * stages: the keep set, then a floor for each (source slot, classification)
 * stratum rarest first, then one return at a time from each occupied grid
 * cell in spread order, repeating until the budget is gone.
 */
export function selectProfileSectionLod(
  points: ProfileSectionLodInput,
  options: ProfileSectionLodOptions,
): Uint32Array {
  const n = Math.max(0, Math.min(points.count, points.chainage.length, points.height.length));
  if (n === 0) return new Uint32Array(0);

  const cap = Number.isFinite(options.cap) ? Math.max(0, Math.floor(options.cap)) : 0;
  if (n <= cap) return ascendingRun(n);

  const selected = forcedFlags(options.keep, n);
  let taken = 0;
  for (let i = 0; i < n; i++) if (selected[i] === 1) taken++;
  if (cap <= 0 || taken >= cap) return flaggedIndices(selected, n, taken);

  const grid = profileSectionLodGrid(points, cap);
  const nx = grid.nx;
  const ny = grid.ny;
  const chainage = points.chainage;
  const height = points.height;
  const slot = points.sourceSlot;
  const cls = points.classification;

  // A stratum is one (source slot, classification) pair. Classification is a
  // byte, so the pair packs into one number with neither field reaching the
  // other's digits.
  const strataKey = (i: number): number => slot[i]! * 256 + (cls ? cls[i]! : 0);
  const strataSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = strataKey(i);
    strataSize.set(k, (strataSize.get(k) ?? 0) + 1);
  }
  // Ranked by how few returns a stratum holds, then by key. A cap can leave
  // fewer floor slots than there are strata, and the floors exist for the
  // rare strata, so the rare ones are served first. Neither ordinal comes
  // from the map's iteration order, so which source was read first cannot
  // reach the result.
  const strataKeys = Array.from(strataSize.keys()).sort(
    (a, b) => strataSize.get(a)! - strataSize.get(b)! || a - b,
  );
  const strata = new Map<number, number>();
  for (let g = 0; g < strataKeys.length; g++) strata.set(strataKeys[g]!, g);
  const groupCount = strataKeys.length;

  const bucketOf = (i: number): number => {
    const ix = axisBin(chainage[i]!, grid.minChainage, grid.maxChainage, nx);
    const iy = axisBin(height[i]!, grid.minHeight, grid.maxHeight, ny);
    return (iy * nx + ix) * groupCount + strata.get(strataKey(i))!;
  };

  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = bucketOf(i);
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }

  const bitsX = bitsFor(nx);
  const bitsY = bitsFor(ny);
  const order = Array.from(sizes.keys()).map((key) => {
    const cell = Math.floor(key / groupCount);
    const ix = cell % nx;
    const iy = (cell - ix) / nx;
    return { key, group: key - cell * groupCount, spread: spreadKey(ix, iy, bitsX, bitsY) };
  });
  order.sort((a, b) => a.spread - b.spread || a.group - b.group || a.key - b.key);

  const bucketCount = order.length;
  const rank = new Map<number, number>();
  const starts = new Uint32Array(bucketCount + 1);
  for (let b = 0; b < bucketCount; b++) {
    rank.set(order[b]!.key, b);
    starts[b + 1] = starts[b]! + sizes.get(order[b]!.key)!;
  }
  const members = new Uint32Array(n);
  const write = starts.slice(0, bucketCount);
  for (let i = 0; i < n; i++) {
    const b = rank.get(bucketOf(i))!;
    members[write[b]!] = i;
    write[b]! += 1;
  }

  // Returns inside a bucket sit in ascending index, so a permuted input draws
  // a different return from the same bucket but never a different count.
  const cursor = new Uint32Array(bucketCount);
  const takeFrom = (b: number): number => {
    const base = starts[b]!;
    const end = starts[b + 1]! - base;
    let c = cursor[b]!;
    while (c < end) {
      const i = members[base + c]!;
      c++;
      if (selected[i] === 0) {
        cursor[b] = c;
        selected[i] = 1;
        return i;
      }
    }
    cursor[b] = c;
    return -1;
  };

  const perStratum = Math.max(1, Math.floor((cap * FLOOR_SHARE) / groupCount));
  const strataBuckets: number[][] = Array.from({ length: groupCount }, () => []);
  for (let b = 0; b < bucketCount; b++) strataBuckets[order[b]!.group]!.push(b);

  for (let g = 0; g < groupCount && taken < cap; g++) {
    const buckets = strataBuckets[g]!;
    let got = 0;
    let moved = true;
    while (moved && got < perStratum && taken < cap) {
      moved = false;
      for (let j = 0; j < buckets.length && got < perStratum && taken < cap; j++) {
        if (takeFrom(buckets[j]!) < 0) continue;
        got++;
        taken++;
        moved = true;
      }
    }
  }

  let moved = true;
  while (moved && taken < cap) {
    moved = false;
    for (let b = 0; b < bucketCount && taken < cap; b++) {
      if (takeFrom(b) < 0) continue;
      taken++;
      moved = true;
    }
  }

  return flaggedIndices(selected, n, taken);
}
