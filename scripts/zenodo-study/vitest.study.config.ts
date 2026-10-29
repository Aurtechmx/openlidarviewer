/**
 * Runs the Node half of the Zenodo small-file study (`nodePaths.study.ts`)
 * with the same defines as the unit suite. Not part of `vitest run`: the
 * default include covers `tests/` only, and this file is used by
 * `scripts/zenodo-study/run.mjs` alone.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config';

export default mergeConfig(
  { ...base, test: { ...base.test, include: [] } },
  defineConfig({
    test: {
      include: ['scripts/zenodo-study/nodePaths.study.ts'],
      testTimeout: 600_000,
      hookTimeout: 600_000,
      fileParallelism: false,
      coverage: { enabled: false },
    },
  }),
);
