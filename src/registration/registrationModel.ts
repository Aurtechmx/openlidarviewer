/**
 * registrationModel.ts — choose HOW to register two clouds, fail-closed.
 *
 * The right registration model depends on what is known about the data, and the
 * wrong one silently corrupts the answer:
 *
 *  - MOUNT. Both clouds have a proven, compatible CRS and georeferenced origins,
 *    so they are already in one frame — place them directly, run no ICP. Fitting
 *    a transform here would move correctly-placed data.
 *  - PLANAR ICP. Two AIRBORNE epochs of the same area without a proven common
 *    frame (change detection). The applied transform is yaw + x/y; the fitted z
 *    is not applied. Discarding z does not stop x/y from absorbing real change on
 *    a slope, so the epoch pipeline (`terrain/change/alignEpochs`) fits only when
 *    the surface constrains yaw, x, y and z independently (an undamped
 *    observability test) and refuses a plane or a single slope. The solver lives
 *    at `./planarIcp` (a re-export of the tested `terrain/change` planar
 *    `icpRegister`), so this case is allowed, not withheld.
 *  - FULL 6-DOF. Terrestrial or object scans with no shared frame — solve all
 *    six degrees of freedom.
 *
 * It refuses rather than guess when the frame is incompatible, the capture is
 * unknown, or the expected overlap is too low to register at all. Pure and
 * deterministic; the shell reads this to pick the aligner.
 */

export type RegistrationModel = 'mount' | 'planar-icp' | 'full-6dof';

export type CaptureKind = 'airborne' | 'terrestrial' | 'object' | 'mixed' | 'unknown';

export interface RegistrationInputs {
  /** Both clouds carry a proven, mutually-compatible CRS. */
  readonly crsCompatible: boolean;
  /** Both clouds carry georeferenced origins (so a mount needs no solve). */
  readonly originsKnown: boolean;
  readonly capture: CaptureKind;
  /** Same area at different times — a change-detection pair. */
  readonly sameAreaEpochs: boolean;
  /** Estimated overlap fraction (0..1); undefined = unknown. */
  readonly overlapEstimate?: number;
  /** Below this overlap, registration is refused. Default 0.2. */
  readonly minOverlap?: number;
}

export interface RegistrationDecision {
  readonly model?: RegistrationModel;
  readonly allowed: boolean;
  /** UPPER_SNAKE reason code. */
  readonly reasonCode: string;
  readonly reason: string;
}

/** Select the registration model, or refuse. */
export function selectRegistrationModel(inp: RegistrationInputs): RegistrationDecision {
  const minOverlap = inp.minOverlap ?? 0.2;

  // Too little overlap to register anything (mount excepted — it needs no overlap).
  const overlapKnownLow = inp.overlapEstimate !== undefined && inp.overlapEstimate < minOverlap;

  // Proven CRS + origins → the clouds are already in one frame; mount, no solve.
  if (inp.crsCompatible && inp.originsKnown) {
    return { model: 'mount', allowed: true, reasonCode: 'PROVEN_FRAME_MOUNT', reason: 'Both clouds share a proven, compatible frame with known origins; place directly without solving a transform.' };
  }

  if (overlapKnownLow) {
    return { allowed: false, reasonCode: 'LOW_OVERLAP', reason: `Estimated overlap ${(inp.overlapEstimate! * 100).toFixed(0)}% is below the ${(minOverlap * 100).toFixed(0)}% needed to register.` };
  }

  // Airborne change-detection epochs without a proven frame use planar ICP
  // (yaw + horizontal translation applied, the fitted Z not applied), gated on
  // observability in the epoch pipeline. That solver exists — `src/registration/planarIcp` re-exports
  // the tested planar `icpRegister` already wired to the epoch-compare pipeline —
  // so the planar model is now selected and allowed rather than withheld.
  if (inp.capture === 'airborne' && inp.sameAreaEpochs) {
    return { model: 'planar-icp', allowed: true, reasonCode: 'PLANAR_ICP_AVAILABLE', reason: 'Two airborne epochs of the same area register with a planar ICP (yaw + XY applied, the fitted Z not applied), only where the surface constrains yaw, x, y and z independently; a plane or a single slope is refused as unobservable.' };
  }

  // Terrestrial / object → full 6-DOF.
  if (inp.capture === 'terrestrial' || inp.capture === 'object') {
    return { model: 'full-6dof', allowed: true, reasonCode: 'TERRESTRIAL_6DOF', reason: 'Terrestrial/object scans with no shared frame; solve all six degrees of freedom.' };
  }

  // Unknown capture with no proven frame — refuse rather than guess a model.
  return { allowed: false, reasonCode: 'MODEL_UNDETERMINED', reason: 'No proven frame and the capture type is unknown; a registration model cannot be chosen safely.' };
}
