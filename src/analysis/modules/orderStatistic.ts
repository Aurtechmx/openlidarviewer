/**
 * orderStatistic.ts: the value a full ascending sort would place at index k,
 * found by selection in linear expected time instead of an O(n log n) sort.
 *
 * The answer is the one `Float64Array.prototype.sort` gives, bit for bit: NaN
 * sorts after every number and -0 before +0. Selection compares with `<`,
 * which treats the two zeros as equal, so a zero answer is settled from the
 * zero counts. The input array is reordered in place; its values (as a
 * multiset) are unchanged.
 */

/** Move every NaN to the end; returns how many values are not NaN. */
function parkNaNs(a: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v === v) {
      a[i] = a[m];
      a[m++] = v;
    }
  }
  return m;
}

/** -0 or +0 for sorted position k, given that position holds a zero. */
function zeroAt(a: Float64Array, m: number, k: number): number {
  let below = 0;
  for (let i = 0; i < m; i++) {
    const v = a[i];
    if (v < 0 || Object.is(v, -0)) below++;
  }
  return k < below ? -0 : 0;
}

/**
 * Three-way quickselect over a[0, m): leaves a[k] in its sorted place, every
 * value before it no greater and every value after it no smaller.
 *
 * The pivot is the median of three positions drawn from a fixed-seed
 * generator, so ordered or patterned input (a scan written row by row) cannot
 * make every round shrink the range by one. After more rounds than a sane run
 * needs, the rest of the range is sorted, which bounds the worst case at a
 * sort's cost. Neither choice changes the answer, only how fast it comes.
 */
function select(a: Float64Array, m: number, k: number): void {
  let lo = 0;
  let hi = m - 1;
  let seed = 0x9e3779b9;
  const pick = (span: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return lo + (seed % span);
  };
  let rounds = 4 * Math.ceil(Math.log2(m + 1)) + 8;
  while (lo < hi) {
    if (rounds-- <= 0) {
      a.subarray(lo, hi + 1).sort();
      return;
    }
    const span = hi - lo + 1;
    const x = a[pick(span)];
    const y = a[pick(span)];
    const z = a[pick(span)];
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : (x < z ? x : y < z ? z : y);
    let lt = lo;
    let gt = hi;
    let i = lo;
    while (i <= gt) {
      const v = a[i];
      if (v < pivot) {
        a[i++] = a[lt];
        a[lt++] = v;
      } else if (v > pivot) {
        a[i] = a[gt];
        a[gt--] = v;
      } else {
        i++;
      }
    }
    if (k < lt) hi = lt - 1;
    else if (k > gt) lo = gt + 1;
    else return;
  }
}

/** The value at index k of `Float64Array.from(a).sort()`. Reorders `a`. */
export function sortedValueAt(a: Float64Array, k: number): number {
  const m = parkNaNs(a);
  if (k >= m) return NaN;
  select(a, m, k);
  const v = a[k];
  return v === 0 ? zeroAt(a, m, k) : v;
}

/**
 * The median as the sort-based form computed it: the middle value, or the
 * mean of the two middle values for an even count, and 0 for no values.
 * Reorders `a`.
 */
export function medianOf(a: Float64Array): number {
  const n = a.length;
  if (n === 0) return 0;
  const mid = n >>> 1;
  const upper = sortedValueAt(a, mid);
  if (n % 2 === 1) return upper;
  if (upper !== upper) return NaN;
  // Selection left every value below index mid at or under a[mid]; the
  // largest of them is the sorted value at mid - 1.
  let lower = a[0];
  for (let i = 1; i < mid; i++) if (a[i] > lower) lower = a[i];
  if (lower === 0) lower = zeroAt(a, n, mid - 1);
  return (lower + upper) / 2;
}
