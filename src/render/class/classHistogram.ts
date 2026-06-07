/**
 * classHistogram.ts
 *
 * Pure per-class occurrence counting for ASPRS classification buffers,
 * plus an incremental merge so a streaming loader can accumulate
 * counts chunk by chunk. The histogram drives the class panel (which
 * codes are present, how many points each holds) without ever touching
 * the GPU or the DOM.
 *
 * Class codes are normalised to a byte: float buffers are floored to an
 * integer first, then every code is masked with `& 0xff`. Only codes
 * that actually appear get an entry — absent codes stay absent so the
 * UI can show exactly the classes the cloud contains.
 *
 * Pure data — no DOM, no three.js, no I/O.
 */

/**
 * Counts occurrences of each class code present in the buffer. Float
 * codes are floored to an integer; every code is masked with `& 0xff`.
 * Returns a map keyed by class code, containing only codes that appear.
 */
export function countClasses(
  buf: Uint8Array | Uint16Array | Float32Array,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < buf.length; i++) {
    const code = Math.floor(buf[i]) & 0xff;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}

/**
 * Returns a new map summing the counts of `a` and `b` per class code.
 * Neither input is mutated — used to fold streamed chunk histograms
 * into a running total.
 */
export function mergeCounts(
  a: Map<number, number>,
  b: Map<number, number>,
): Map<number, number> {
  const merged = new Map<number, number>(a);
  for (const [code, n] of b) {
    merged.set(code, (merged.get(code) ?? 0) + n);
  }
  return merged;
}
