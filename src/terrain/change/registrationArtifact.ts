/**
 * registrationArtifact.ts — a typed provenance record for a repeat-epoch
 * registration.
 *
 * `alignEpochs` already solves and reports the transform (yaw, translation,
 * residual, applied-or-refused) in {@link EpochAlignment}, but that value has no
 * identity: it does not say WHICH two scans it registered, by WHICH method at
 * which version, or WHEN. A {@link RegistrationArtifact} is that identity wrapped
 * around the alignment — the small, honest provenance record a change comparison
 * can carry, log, or export beside its result so "what aligned what, and was it
 * trusted" travels with the numbers rather than only living in a display string.
 *
 * Pure data: it composes the alignment the solver already produced with the
 * source/target identity the caller holds and the registered method reference.
 * It states the transform and whether it was APPLIED; it never re-solves and
 * never moves geometry. The full registration workspace (tie points,
 * accept/reject, a persisted registry) is a separate, larger piece.
 */

import type { EpochAlignment, EpochAppliedDof } from './alignEpochs';
import type { Vec3 } from './icpRegister';
import type { RigidObservability } from './rigidObservability';
import { methodRef, type MethodRef } from '../../science/methodRegistry';

/** The registered method the epoch alignment implements. */
const EPOCH_ALIGN_METHOD_ID = 'olv.registration.epoch-horizontal-icp';

/** Identity the caller supplies for the two registered scans. */
export interface RegistrationScans {
  /** The scan held fixed (the "before" epoch). */
  readonly targetId: string;
  readonly targetName: string;
  /** The scan transformed onto the target (the "after" epoch). */
  readonly sourceId: string;
  readonly sourceName: string;
}

/**
 * A repeat-epoch registration, as a provenance record. Carries the identity of
 * the two scans, the method that solved it, the transform and its residual, and
 * whether it was applied — plus a `generatedAt` stamp so a later reader can tell
 * a fresh registration from a stale one.
 */
export interface RegistrationArtifact {
  readonly kind: 'registration';
  readonly method: MethodRef;
  readonly scans: RegistrationScans;
  /** Whether a transform was solved and applied (vs. refused / not attempted). */
  readonly applied: boolean;
  readonly refused: boolean;
  /** Which degrees of freedom the applied transform used. */
  readonly appliedDof: EpochAppliedDof;
  /**
   * RMS residual of the solver's yaw + x/y/z fit, in metres (not what was
   * applied). Null when no fit produced one, with the reason beside it.
   */
  readonly solverResidualM: number | null;
  readonly solverResidualReason: string | null;
  /**
   * RMS residual re-measured at the pose actually applied (identity if none),
   * in metres. Null when it cannot be measured, with the reason beside it: no
   * sampled point has a partner within the correspondence distance when the
   * real change is larger than that distance.
   */
  readonly appliedTransformResidualM: number | null;
  readonly appliedTransformResidualReason: string | null;
  /** Solved yaw about vertical, in degrees. */
  readonly yawDeg: number;
  /** Solved translation (metres) mapping source onto target, yaw about the world origin. */
  readonly translation: Vec3;
  /**
   * Displacement (metres) of a source point at the target sample's centroid:
   * the shift to state. The translation alone is not, because the yaw turns
   * about the world origin. Absent when no fit ran.
   */
  readonly centroidShiftM?: Vec3;
  /** Fraction of the scenes that overlapped, 0..1. */
  readonly overlapFraction: number;
  /**
   * A pose was estimated at all. False when the supplied coordinates were kept
   * (`frameKept`), when the geometry was unobservable, or when no fit ran.
   */
  readonly estimated: boolean;
  /** Both epochs declare one horizontal CRS; their coordinates were kept, no fit ran. */
  readonly frameKept: boolean;
  /** The fit was refused because the geometry does not determine the pose. */
  readonly unobservable: boolean;
  /** Observability of the fit (absent when no fit ran). */
  readonly observability?: RigidObservability;
  /**
   * Registration uncertainty (σreg, metres). Always null in this build: it
   * needs an independent assessment on stable reference areas, and neither
   * fit residual above is a substitute. Kept as its own field so a residual is
   * never read as one.
   */
  readonly registrationSigmaM: null;
  /** Epoch-millisecond stamp of when this record was built (staleness marker). */
  readonly generatedAt: number;
}

/** A residual as a finite number, or null with the reason it has none. */
function residualFields(
  a: EpochAlignment,
): Pick<RegistrationArtifact, 'solverResidualM' | 'solverResidualReason' | 'appliedTransformResidualM' | 'appliedTransformResidualReason'> {
  const solverReason = a.frameKept
    ? 'not computed: the supplied coordinates were kept and no fit ran'
    : a.unobservable
      ? 'not computed: the geometry does not determine the pose'
      : !a.attempted || a.degenerate
        ? 'not computed: not enough points to register'
        : 'not computed: no fit residual was produced';
  const appliedReason = !a.attempted || a.degenerate
    ? 'not measured: no fit was attempted'
    : 'not measurable: change exceeds the correspondence distance';
  const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);
  const solver = finite(a.solverResidualM);
  const applied = finite(a.appliedTransformResidualM);
  return {
    solverResidualM: solver,
    solverResidualReason: solver === null ? solverReason : null,
    appliedTransformResidualM: applied,
    appliedTransformResidualReason: applied === null ? appliedReason : null,
  };
}

/** Build the provenance record from a solved alignment and the scan identity. */
export function buildRegistrationArtifact(
  alignment: EpochAlignment,
  scans: RegistrationScans,
  generatedAt: number,
): RegistrationArtifact {
  return {
    kind: 'registration',
    method: methodRef(EPOCH_ALIGN_METHOD_ID),
    scans,
    applied: alignment.applied,
    refused: alignment.refused,
    appliedDof: alignment.appliedDof,
    ...residualFields(alignment),
    yawDeg: alignment.yawDeg,
    translation: alignment.translation,
    ...(alignment.centroidShiftM ? { centroidShiftM: alignment.centroidShiftM } : {}),
    overlapFraction: alignment.overlapFraction,
    estimated: alignment.attempted && !alignment.degenerate && alignment.unobservable !== true,
    frameKept: alignment.frameKept === true,
    unobservable: alignment.unobservable === true,
    ...(alignment.observability ? { observability: alignment.observability } : {}),
    registrationSigmaM: null,
    generatedAt,
  };
}

/**
 * A one-line, honest summary of a registration for the compare readout. States
 * the applied case with its residual and DOF, and names the refused / not-run
 * cases plainly rather than implying a transform that was not used.
 */
export function summarizeRegistration(a: RegistrationArtifact): string {
  const m = `${a.method.id}@${a.method.version}`;
  if (a.applied) {
    return (
      `Registration: applied (${a.appliedDof}) — ` +
      (a.centroidShiftM ? `shift ${Math.hypot(a.centroidShiftM[0], a.centroidShiftM[1]).toFixed(3)} m at the centroid, ${a.yawDeg.toFixed(3)}° yaw, ` : '') +
      `residual at applied pose ${a.appliedTransformResidualM !== null ? `${a.appliedTransformResidualM.toFixed(3)} m` : a.appliedTransformResidualReason}, ` +
      `solver fit residual ${a.solverResidualM !== null ? `${a.solverResidualM.toFixed(3)} m` : a.solverResidualReason}, overlap ${Math.round(a.overlapFraction * 100)}%; ` +
      `registration uncertainty not quantified · ${m}`
    );
  }
  if (a.frameKept) {
    return `Registration: not estimated — epochs compared in their supplied coordinates; registration uncertainty not quantified · ${m}`;
  }
  if (a.unobservable) {
    return `Registration: refused — the geometry does not constrain the pose (unobservable); epochs compared unshifted; registration uncertainty not quantified · ${m}`;
  }
  if (a.refused) {
    return `Registration: refused — solver fit residual ${a.solverResidualM !== null ? `${a.solverResidualM.toFixed(3)} m` : a.solverResidualReason} exceeded the gate; epochs compared unshifted · ${m}`;
  }
  return `Registration: not applied — epochs compared in their own frames · ${m}`;
}
