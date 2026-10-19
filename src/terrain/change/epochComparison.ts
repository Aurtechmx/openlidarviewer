/**
 * epochComparison.ts — the compute sequence of a two-epoch elevation compare.
 *
 * Align the after epoch (or keep its coordinates), build the shared DTMs with a
 * hold-out σz per epoch, and difference them at the propagated level of
 * detection. The compare flow and its tests both call this one function, so a
 * test of the sequence reads the gate, the σz inputs and the missing σreg the
 * app uses and cannot drift from them.
 *
 * Pure: no DOM, no I/O.
 */

import type { EpochFrameOptions } from '../../geo/frameCompatibility';
import { alignEpochClouds, type EpochAlignment } from './alignEpochs';
import { buildSharedEpochDtms, type EpochCloud, type EpochDtms } from './compareEpochs';
import { compareDtms, type CompareDtmsOptions, type EpochComparison } from './compareDtms';
import { propagatedLevelOfDetection } from './propagatedLod';

/**
 * The alignment's residual gate as a share of the before epoch's horizontal
 * span: a fit whose residual exceeds it is refused.
 */
export const ALIGNMENT_RESIDUAL_SPAN_FRACTION = 0.1;

export interface EpochComparisonInput {
  readonly beforeCloud: EpochCloud;
  readonly afterCloud: EpochCloud;
  /** The before epoch's horizontal span in SOURCE units; the gate is metres. */
  readonly span: number;
  /** The frame facts both epochs share (geographic, unit known, metres per unit). */
  readonly frames: EpochFrameOptions;
  /** The before epoch's own vertical scale (it scales the Δz result). */
  readonly verticalUnitToMetres: CompareDtmsOptions['verticalUnitToMetres'];
  /** False when the vertical unit is unknown, so σz cannot be stated in metres. */
  readonly verticalUnitKnown: boolean;
}

export type EpochComparisonRun =
  | { readonly ok: false; readonly alignment: EpochAlignment }
  | {
      readonly ok: true;
      readonly alignment: EpochAlignment;
      /** The after epoch as compared: moved if the alignment was applied, else the supplied one. */
      readonly alignedAfter: EpochCloud;
      readonly dtms: EpochDtms;
      readonly cmp: EpochComparison;
    };

/**
 * Run the sequence. `ok: false` means the epochs share no DTM grid (a layer has
 * no ground points).
 *
 * Epochs in one declared CRS keep their supplied coordinates (a slope cannot
 * separate a horizontal shift from a real height change). Local-frame pairs get
 * the yaw + x/y fit, refused when the surface leaves the pose unobservable or
 * the residual exceeds {@link ALIGNMENT_RESIDUAL_SPAN_FRACTION} of the span.
 * σreg stays null: it needs an independent stable-area assessment, never a fit
 * residual, so the level of detection is a lower bound.
 */
export function runEpochComparison(input: EpochComparisonInput): EpochComparisonRun {
  const { beforeCloud, afterCloud, span, frames } = input;
  const spanUnitToM = frames.horizontalUnitToMetres ?? 1;
  const { after: alignedAfter, alignment } = alignEpochClouds(beforeCloud, afterCloud, {
    maxResidualM: span > 0 ? span * ALIGNMENT_RESIDUAL_SPAN_FRACTION * spanUnitToM : undefined,
    // One shared verdict: the alignment and the difference read the SAME frame
    // facts, so a shift reported in metres is never followed by a difference
    // that refuses metres.
    horizontalUnitKnown: frames.horizontalUnitKnown,
  });
  const dtms = buildSharedEpochDtms(beforeCloud, alignedAfter, { holdoutSigmaZ: true });
  if (!dtms) return { ok: false, alignment };
  const cmp = compareDtms(dtms.before, dtms.after, {
    ...frames,
    verticalUnitToMetres: input.verticalUnitToMetres,
    levelOfDetection: propagatedLevelOfDetection({
      sigmaZBeforeM: dtms.sigmaZ?.before,
      sigmaZAfterM: dtms.sigmaZ?.after,
      sigmaRegM: null,
      verticalUnitKnown: input.verticalUnitKnown,
      horizontalUnitKnown: frames.horizontalUnitKnown,
    }),
  });
  return { ok: true, alignment, alignedAfter, dtms, cmp };
}
