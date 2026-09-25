/**
 * The dynamic-import seam for the `?benchmark=nav` camera driver.
 *
 * Kept out of the live source transform (see `vite.config.ts`) for the reason
 * `lazyChunks.ts` is: the transform rewrites an `import()` specifier into a
 * string-array lookup, and the split chunk is then never emitted. It lives
 * apart from `lazyChunks.ts` because that module is in the startup shell and
 * this seam is reached only from the navigation controller's chunk.
 */
export const loadNavDriver = () => import('./navDriver');
