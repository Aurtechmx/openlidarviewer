/**
 * contextRecoveryLoader.ts — the split point for `contextRecovery.ts`.
 *
 * The renderer rebuild only runs after a WebGL context is lost and restored,
 * so it loads on demand instead of riding in the Viewer chunk. The `import()`
 * specifier must stay a literal for the bundler, which is why this module is
 * excluded from the live source transform (vite.config.ts) and listed in
 * scripts/lint-inline-imports.mjs.
 */
export const loadContextRecovery = () => import('./contextRecovery');
