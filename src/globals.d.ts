/**
 * Ambient declarations for build-time globals.
 *
 * `__APP_VERSION__` is replaced by Vite's `define` with the version string
 * from package.json (see vite.config.ts).
 */
declare const __APP_VERSION__: string;

/**
 * `__BUILD_IDENTITY__` is replaced by Vite's `define` with the single
 * build-time identity object (version, commit, dirty, builtAt, node, channel).
 * The structural shape here must match `BuildIdentity` in src/build/buildIdentity.ts,
 * which reads and re-exports it. See `resolveBuildIdentity` in vite.config.ts.
 */
declare const __BUILD_IDENTITY__: {
  readonly version: string;
  readonly commit: string;
  readonly dirty: boolean;
  readonly builtAt: string;
  readonly node: string;
  readonly channel: string;
};

/**
 * `__OLV_TEST_SEAM__` is replaced by Vite's `define` with a boolean literal:
 * true for the dev server and for a build run with OLV_TEST_SEAM=1 (the
 * Playwright webServer), false everywhere else. It guards the `?test=1`
 * seam in src/main.ts so the minifier removes it from shipped builds.
 */
declare const __OLV_TEST_SEAM__: boolean;

/**
 * Inter is not part of the shipped bundle — the interface face is Manrope
 * (`--font` in style.css) with JetBrains Mono for monospace. The package is
 * kept for `scripts/make-brand-rasters.py`, which instances its variable woff2
 * out of node_modules to typeset the OG-card tagline. This declaration exists
 * so a side-effect CSS import of it would still type-check.
 */
declare module '@fontsource-variable/inter';
