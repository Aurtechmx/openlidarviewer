/**
 * tests/bufferTransfer.ts
 *
 * Faithful `postMessage` transfer semantics for the fake workers in the decode
 * pool tests. Shared so the three of them model detachment the same way.
 *
 * Why it matters: "each buffer is transferred exactly once" is only a real
 * assertion if a second transfer would actually fail. A fake worker that just
 * records its transfer list would happily accept the same buffer twice, and the
 * ownership bug the pool exists to prevent would pass every test.
 */

/**
 * Has this buffer already been transferred away?
 *
 * `ArrayBuffer.prototype.detached` is the direct answer but needs the ES2024
 * lib, and this project targets ES2022/ES2023 — so a detached buffer is
 * identified by its byte length collapsing to 0, which is what detaching does.
 * Every buffer in these tests is created non-empty, so a zero length can only
 * mean it went across.
 */
export function isDetached(buffer: ArrayBuffer): boolean {
  return buffer.byteLength === 0;
}

/**
 * Transfer a buffer the way `postMessage` would: throw if it has already gone,
 * otherwise really detach it. The clone is discarded — detaching the original
 * is the whole point.
 */
export function transferBuffer(buffer: ArrayBuffer): void {
  if (isDetached(buffer)) {
    throw new Error('DataCloneError: ArrayBuffer is detached and could not be cloned.');
  }
  structuredClone(buffer, { transfer: [buffer] });
}
