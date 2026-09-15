/**
 * gridMorphology.ts
 *
 * Exact square min/max morphology on a dense grid, separable and O(cells)
 * whatever the radius. This is the classifier's opening (its progressive
 * morphological object test); `groundFilter.morphOpen` computes the same
 * square opening for the terrain ground filter by a direct window scan.
 * `tests/morphologyEquivalence.test.ts` holds the two to byte identity on
 * finite grids.
 *
 * Input must be hole-free: a NaN cell breaks the deque's ordering and the
 * result around it is undefined. The classifier fills holes first
 * (`fillHoles`); the ground filter's own opening ignores NaN instead. That
 * difference is the one thing the two implementations do not share.
 *
 * Pure: no DOM, no three.js.
 */

/**
 * Centred sliding-window extreme (min or max) over one logical line of `len`
 * elements, where element k lives at `base + k*stride`. A monotonic deque
 * makes the whole line O(len), independent of the window radius.
 */
function lineExtreme(
  src: Float32Array,
  dst: Float32Array,
  base: number,
  stride: number,
  len: number,
  r: number,
  isMin: boolean,
  dq: Int32Array,
): void {
  let head = 0, tail = 0, next = 0;
  for (let i = 0; i < len; i++) {
    const hi = Math.min(i + r, len - 1);
    while (next <= hi) {
      const v = src[base + next * stride];
      while (tail > head) {
        const tv = src[base + dq[tail - 1] * stride];
        if (isMin ? tv < v : tv > v) break; // keep the deque monotonic
        tail--;
      }
      dq[tail++] = next;
      next++;
    }
    const lo = i - r;
    while (dq[head] < lo) head++;
    dst[base + i * stride] = src[base + dq[head] * stride];
  }
}

/** Separable square min (`isMin`) or max filter of `radius` cells. */
export function morphExtreme(
  src: Float32Array,
  W: number,
  H: number,
  r: number,
  isMin: boolean,
): Float32Array {
  const dq = new Int32Array(Math.max(W, H));
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) lineExtreme(src, tmp, y * W, 1, W, r, isMin, dq);
  const out = new Float32Array(W * H);
  for (let x = 0; x < W; x++) lineExtreme(tmp, out, x, W, H, r, isMin, dq);
  return out;
}

/**
 * Morphological opening (erosion then dilation) with a flat square element
 * of radius `r` cells: removes positive features smaller than the element.
 */
export function morphOpen(src: Float32Array, W: number, H: number, r: number): Float32Array {
  return morphExtreme(morphExtreme(src, W, H, r, true), W, H, r, false);
}
