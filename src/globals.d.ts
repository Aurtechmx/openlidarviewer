/**
 * Ambient declarations for build-time globals.
 *
 * `__APP_VERSION__` is replaced by Vite's `define` with the version string
 * from package.json (see vite.config.ts).
 */
declare const __APP_VERSION__: string;

/** Side-effect import of the self-hosted Inter variable font (CSS only). */
declare module '@fontsource-variable/inter';
