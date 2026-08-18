/**
 * descriptor-fixture-params.mjs — frozen parameters for the TPI and VRM
 * cross-implementation fixtures. Pure (no runtime imports) so the cross-check
 * tests can import the constants without pulling in the generator's node
 * dependencies. See scripts/generate-descriptor-crosscheck.mjs for the surfaces.
 */
export const N = 60;
export const CELL = 1;
export const TPI_C = 0.01; // quadratic coefficient for the TPI fixture
export const VRM_A = 0.2; // tilt for the VRM fixture
export const VRM_C = 0.004; // curvature for the VRM fixture

/** Cell-centre coordinate for column/row index i (grid re-centred on the origin). */
export const coord = (i) => (i - N / 2 + 0.5) * CELL;
