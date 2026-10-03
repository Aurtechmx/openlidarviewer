/**
 * The dynamic-import seam for the `?test=1` Playwright seam.
 *
 * Kept out of the live source transform (see `vite.config.ts`) for the reason
 * `lazyChunks.ts` is: the transform rewrites an `import()` specifier into a
 * string-array lookup, and the split chunk is then never emitted. It lives
 * apart from `lazyChunks.ts` so the import can sit behind the same
 * `__OLV_TEST_SEAM__` constant as its only caller: a build with it false emits
 * no seam chunk.
 */
export const loadTestSeamMount = (): Promise<typeof import('./testSeamMount')> =>
  __OLV_TEST_SEAM__
    ? import('./testSeamMount')
    : Promise.reject(new Error('test seam not built'));
