/**
 * The dynamic-import seam for the `?governor=on` frame budget governor.
 *
 * Kept out of the live source transform (see `vite.config.ts`) for the reason
 * `perf/navDriverLoader.ts` is: the transform rewrites an `import()` specifier
 * into a string-array lookup, and the split chunk is then never emitted.
 */
export const loadGovernorWiring = () => import('./governorWiring');
