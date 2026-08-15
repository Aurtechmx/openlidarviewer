import { describe, it, expect } from 'vitest';
import { icpRegister as sourceIcp } from '../src/terrain/change/icpRegister';
import { icpRegister, planarIcpRegister, applyIcp } from '../src/registration/planarIcp';

/**
 * The registration layer's planar-ICP seam is a re-export of the ONE tested
 * planar solver in terrain/change, not a second implementation. This pins that:
 * the canonical registration entry is byte-identical to the live solver, so
 * `registrationModel`'s "planar ICP is available at ./planarIcp" claim is true
 * and there is no divergent copy to drift. The solver's numerical behaviour is
 * covered by the terrain/change ICP tests.
 */
describe('src/registration/planarIcp seam', () => {
  it('re-exports the live terrain/change planar solver (same function, no copy)', () => {
    expect(icpRegister).toBe(sourceIcp);
    expect(planarIcpRegister).toBe(sourceIcp);
    expect(typeof applyIcp).toBe('function');
  });
});
