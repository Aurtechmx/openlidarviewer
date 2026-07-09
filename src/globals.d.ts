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

/** Side-effect import of the self-hosted Inter variable font (CSS only). */
declare module '@fontsource-variable/inter';
