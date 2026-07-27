// Vitest configuration for the mutation stage only.
//
// Stryker instruments every mutated file for per-test coverage, which slows a
// heavy test past the 15 s the normal suite allows. The gather-density case
// runs in about 9.4 s uninstrumented and exceeds the limit under Stryker.
// Only the timeout differs from the base configuration; the test selection,
// environment and pools are inherited so the mutation stage runs the same
// suite the gate does.
import base from './vitest.config';

export default {
  ...base,
  test: { ...base.test, testTimeout: 120_000, hookTimeout: 120_000 },
};
