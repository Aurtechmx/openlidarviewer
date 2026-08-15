/**
 * planarIcp.ts — the registration layer's canonical planar-constrained ICP.
 *
 * Two implementations of ICP grew up apart: the generic registration layer here
 * (`rigidSolve`, `generalIcp` — full 6-DOF) and a planar, Z-locked solver under
 * `terrain/change` that already ships wired to the "Compare elevation" epoch
 * pipeline. `registrationModel` used to refuse the planar case with
 * `PLANAR_ICP_NOT_IMPLEMENTED` on the grounds that "no planar-constrained solver
 * exists under src/registration" — which was true only because the two trees
 * never referenced each other, not because the solver was missing.
 *
 * This module is the single seam that resolves that split: it re-exports the
 * existing, tested planar solver (`icpRegister` — a full 3-D translation plus a
 * yaw about the world up axis, applied by callers with Z locked so a real
 * vertical change is preserved) under the registration layer's vocabulary. The
 * math is NOT duplicated or moved — the live change-detection path keeps calling
 * the same function — so there is one planar solver with two import homes rather
 * than two implementations.
 */

import { icpRegister, applyIcp } from '../terrain/change/icpRegister';
import type { IcpOptions, IcpResult, Vec3 } from '../terrain/change/icpRegister';

export { icpRegister, applyIcp };
export type { IcpOptions, IcpResult, Vec3 };

/**
 * The planar-constrained (yaw + XY translation) ICP the registration model
 * selects for airborne same-area epochs. A registration-layer alias for
 * `icpRegister`; callers lock Z by zeroing the solved `translation[2]` so
 * genuine elevation change is not absorbed into the fit.
 */
export const planarIcpRegister = icpRegister;
