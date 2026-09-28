// Vitest configuration for the mutation stage only.
//
// Stryker instruments every mutated file for per-test coverage, which slows a
// heavy test past the 15 s the normal suite allows. The gather-density case
// runs in about 9.4 s uninstrumented and exceeds the limit under Stryker. 60 s
// also bounds a runaway mutant on a slower runner.
// The environment and pools are inherited from the base configuration.
//
// One suite is left out: tests/presentationInvariance.test.ts. It asserts that
// presentation settings leave results unchanged by comparing each result across
// 48 presentation states, so a mutant in the numeric core shifts every state
// alike and the suite cannot kill it. Under per-test coverage it runs about 11
// times slower than normal (about 120 s for the file, over 60 s for its DTM
// case alone), which fails the dry run and would add minutes to every mutant.
// The normal unit suite still runs it on every change.
import { configDefaults } from 'vitest/config';
import base from './vitest.config';

export default {
  ...base,
  test: {
    ...base.test,
    exclude: [...(base.test.exclude ?? configDefaults.exclude), 'tests/presentationInvariance.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
};
