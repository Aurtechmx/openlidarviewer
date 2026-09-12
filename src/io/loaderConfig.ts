/**
 * loaderConfig.ts — local-first hardening for @loaders.gl.
 *
 * By default loaders.gl can run its parsers in a Web Worker whose module is
 * fetched from a public CDN (`unpkg.com/@loaders.gl/...`). For an app that
 * promises nothing leaves the device — and to avoid executing un-pinned,
 * un-verified third-party JavaScript in our own origin — we disable worker mode
 * globally. OBJ / PLY / glTF then parse on the main thread, same-origin, with no
 * outbound CDN request. (The heavy LiDAR path uses laz-perf / COPC, not these
 * loaders.gl workers, so the performance trade-off is small.)
 *
 * Import this once for its side effect, before any loaders.gl `parse()` call.
 */

import { setLoaderOptions } from '@loaders.gl/core';

/**
 * The same options, passed EXPLICITLY at every `parse()` call.
 *
 * `setLoaderOptions` writes to a module-global inside `@loaders.gl/core`. That
 * only reaches a parser which resolves to the same instance of that module, and
 * in the chunked live build it does not: the loaders sit in a lazily-imported
 * chunk with its own copy, so the global set in the eager shell never applied
 * and PLY still fetched its worker from `unpkg.com`. Nothing caught it, because
 * the smoke legs serve the bundle without its Content-Security-Policy and the
 * request merely failed over to main-thread parsing.
 *
 * Per-call options are read by the parser that actually runs, so they cannot be
 * separated from it by a chunk boundary.
 */
export const LOCAL_ONLY_LOADER_OPTIONS = {
  worker: false,
  useLocalLibraries: true,
} as const;

setLoaderOptions({
  // No worker spawned ⇒ no worker module fetched from a CDN. This is the single
  // outbound third-party request the app would otherwise make, so removing it
  // keeps the runtime fully self-hosted.
  worker: false,
  // Belt and suspenders: prefer locally-bundled libraries over the CDN base.
  useLocalLibraries: true,
});
