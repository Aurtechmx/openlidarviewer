/**
 * loaderConfig.test.ts — guards the local-first @loaders.gl hardening.
 *
 * Importing src/io/loaderConfig must leave loaders.gl in worker-disabled mode,
 * so OBJ/PLY/glTF parse on the main thread and never fetch a worker module from
 * a public CDN (unpkg.com). If a future change re-enables workers, this fails.
 */

import { describe, it, expect } from 'vitest';
import '../src/io/loaderConfig';
import { getLoaderOptions } from '@loaders.gl/core';

describe('loaderConfig (local-first @loaders.gl)', () => {
  it('disables worker mode globally — no CDN worker fetch', () => {
    // setLoaderOptions normalises `worker` into the `core` namespace.
    const opts = getLoaderOptions() as { core?: { worker?: boolean; useLocalLibraries?: boolean } };
    expect(opts.core?.worker).toBe(false);
    expect(opts.core?.useLocalLibraries).toBe(true);
  });
});
