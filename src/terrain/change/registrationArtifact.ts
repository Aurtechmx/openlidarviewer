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
  /** Final RMS residual of the fit, in metres. */
  readonly rmsResidualM: number;
  /** Solved yaw about vertical, in degrees. */
  readonly yawDeg: number;
  /** Solved translation (metres) mapping source onto target. */
  readonly translation: Vec3;
  /** Fraction of the scenes that overlapped, 0..1. */
  readonly overlapFraction: number;
  /** Epoch-millisecond stamp of when this record was built (staleness marker). */
  readonly generatedAt: number;
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
    rmsResidualM: alignment.rmsResidualM,
    yawDeg: alignment.yawDeg,
    translation: alignment.translation,
    overlapFraction: alignment.overlapFraction,
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
      `residual ${a.rmsResidualM.toFixed(3)} m, overlap ${Math.round(a.overlapFraction * 100)}% · ${m}`
    );
  }
  if (a.refused) {
    return `Registration: refused — residual ${a.rmsResidualM.toFixed(3)} m exceeded the gate; epochs compared unshifted · ${m}`;
  }
  return `Registration: not applied — epochs compared in their own frames · ${m}`;
}
