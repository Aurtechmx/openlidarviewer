/**
 * classBuffer.ts
 *
 * Narrows an arbitrary numeric classification source to a `Uint8Array`
 * so the histogram can count over a concrete byte buffer. A source that
 * is already a `Uint8Array` is returned as-is (no copy); any other
 * `ArrayLike` is copied element by element into a fresh byte buffer,
 * where each write truncates to the low 8 bits.
 *
 * Pure data — no DOM, no three.js, no I/O.
 */

/** Narrow an ArrayLike classification source to a typed buffer for counting. */
export function toClassBuffer(src: ArrayLike<number>): Uint8Array {
  if (src instanceof Uint8Array) return src;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}
