/**
 * loaderNoCdnWorker.test.ts — the mesh loaders never fetch a worker from a CDN.
 *
 * `loaderConfig.ts` called `setLoaderOptions({ worker: false })` once, as a side
 * effect of an import in the shell, and its own comment called that "the single
 * outbound third-party request the app would otherwise make". It did not hold in
 * the shipped bundle: `setLoaderOptions` writes a module-global inside
 * `@loaders.gl/core`, the loaders live in a lazily-imported chunk carrying its
 * own copy of that module, and the parser therefore read defaults. A dropped
 * PLY tried to `importScripts` from `unpkg.com`, which the deploy's own
 * Content-Security-Policy blocks — so on the deployed site the file did not
 * load at all, and off it the app reached a third party it promises not to.
 *
 * Neither smoke leg could see it: both serve the build through `vite preview`,
 * which applies no CSP, and the blocked fetch degraded quietly to main-thread
 * parsing. `npm run test:smoke:deploy` serves the archive with its own
 * `_headers` and does see it.
 *
 * This is the cheap guard for the same rule: every `parse()` passes the options
 * explicitly, so no chunk boundary can separate them from the parser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const parse = vi.fn(async () => ({ attributes: {}, header: {}, indices: undefined }));

vi.mock('@loaders.gl/core', () => ({
  parse,
  setLoaderOptions: vi.fn(),
}));

const { LOCAL_ONLY_LOADER_OPTIONS } = await import('../src/io/loaderConfig');

describe('loaders.gl call sites', () => {
  beforeEach(() => parse.mockClear());

  it('disables worker mode and prefers local libraries', () => {
    expect(LOCAL_ONLY_LOADER_OPTIONS.worker).toBe(false);
    expect(LOCAL_ONLY_LOADER_OPTIONS.useLocalLibraries).toBe(true);
  });

  it('passes the options to the PLY parse, not to a module-global', async () => {
    const { loadPly } = await import('../src/io/loadPly');
    await loadPly(new ArrayBuffer(8)).catch(() => {});
    expect(parse).toHaveBeenCalledWith(expect.anything(), expect.anything(), LOCAL_ONLY_LOADER_OPTIONS);
  });

  it('passes the options to the OBJ parse', async () => {
    const { loadObj } = await import('../src/io/loadObj');
    await loadObj(new ArrayBuffer(8)).catch(() => {});
    expect(parse).toHaveBeenCalledWith(expect.anything(), expect.anything(), LOCAL_ONLY_LOADER_OPTIONS);
  });

  it('passes the options to the glTF parse', async () => {
    const { loadGltf } = await import('../src/io/loadGltf');
    await loadGltf(new ArrayBuffer(8)).catch(() => {});
    expect(parse).toHaveBeenCalledWith(expect.anything(), expect.anything(), LOCAL_ONLY_LOADER_OPTIONS);
  });
});
