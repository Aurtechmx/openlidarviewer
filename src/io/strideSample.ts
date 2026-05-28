/**
 * strideSample.ts
 *
 * Stratified, jittered subsampling for the fast-load path.
 *
 * Plain decimation — keep record 0, N, 2N, … — aliases badly with the way
 * LiDAR files store points: records are written in scan order, so a fixed
 * stride locks onto the scan geometry, keeps the same phase on every scan
 * line, and the cloud shows regular scan-line banding.
 *
 * Stratified sampling fixes this. The records are split into consecutive
 * buckets of `step`, and one record is taken from each bucket at a *jittered*
 * offset. Every bucket still contributes exactly one point — so the density
 * stays uniform and the kept count is unchanged — but the per-bucket phase is
 * randomised, so there is no periodic structure left to alias.
 *
 * The randomness is a seeded PRNG, so a given file always loads identically
 * and the behaviour is unit-testable. No DOM or three.js dependency.
 */

/** Fixed seed for the stride sampler — keeps every load deterministic. */
export const STRIDE_SAMPLE_SEED = 0x9e3779b9;

/**
 * A small, fast, deterministic PRNG (mulberry32). Returns a function that
 * yields successive values in the range [0, 1).
 */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The record index chosen within bucket `b` — a jittered offset inside the
 * bucket's `[b*step, (b+1)*step)` range, clamped to the last valid record.
 *
 * Consumes exactly one value from `rand`, so a caller must invoke it once per
 * bucket, in ascending bucket order, for the sampling to be reproducible.
 */
export function pickInBucket(
  b: number,
  step: number,
  count: number,
  rand: () => number,
): number {
  const offset = Math.floor(rand() * step);
  return Math.min(count - 1, b * step + offset);
}

/**
 * The full set of record indices a stratified stride-decode keeps, in
 * ascending order — one per bucket. Pure; used by the tests and as the
 * reference definition of the sampling. (The decoders compute the same
 * indices on the fly via `pickInBucket`, so they never materialise this.)
 */
export function stratifiedSampleIndices(
  count: number,
  step: number,
  seed = STRIDE_SAMPLE_SEED,
): number[] {
  const s = Math.max(1, Math.floor(step));
  const total = count > 0 ? Math.ceil(count / s) : 0;
  const rand = makePrng(seed);
  const out: number[] = [];
  for (let b = 0; b < total; b++) out.push(pickInBucket(b, s, count, rand));
  return out;
}
