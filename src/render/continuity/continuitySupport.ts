/**
 * continuitySupport.ts
 *
 * How well a pixel is backed by nearby samples, used to decide whether the
 * renderer may fill it in.
 *
 * The name is load-bearing. This viewer already reports confidence about
 * measured things, in the measure panel, the analyse panel and the findings
 * list, and those numbers describe how well something was surveyed. This one
 * describes how safe a pixel is to draw, and a reader who met it as
 * "confidence" beside those would reasonably take it for the same kind of
 * claim. It is called support everywhere, and a test refuses the other word.
 *
 * The parts combine by their weakest, not their average. A pixel bracketed by
 * plenty of samples that disagree about depth sits on an edge, and a pixel with
 * perfect depth agreement and almost no samples under it is a guess; averaging
 * would let either be carried by the other into a fill. Taking the lowest means
 * every signal has to be satisfied, which is the right shape for a gate on
 * inventing pixels rather than on presenting them.
 *
 * Pure: no three.js, no framebuffer. Presentation only. Support is not a
 * measurement, has no units, and nothing derived from it may reach picking,
 * measurement, terrain, export or claim evidence.
 */
import { clamp01 } from '../../numeric';
import type { PhaseCount } from './temporalPhase';

/** What is known about a pixel's neighbourhood. */
export interface SupportInput {
  /** Source samples that landed on or beside this pixel. */
  readonly directSamples: number;
  /** How many temporal phases have contributed so far. */
  readonly phasesContributed: number;
  /** How many phases make a complete sweep. */
  readonly phaseCount: PhaseCount;
  /**
   * How well the neighbouring depths agree, in `[0, 1]`. The caller derives it
   * from the same depth rule the merge and gap passes use, so there is one
   * notion of a shared surface rather than three.
   */
  readonly neighbourCoherence: number;
}

/**
 * Samples at which the sample term is satisfied.
 *
 * Four is two opposite pairs, which is the neighbourhood the gap pass already
 * treats as evidence that a surface spans a pixel. A starting value: what it
 * should be comes from real scenes at several densities.
 */
export const SAMPLES_FOR_FULL_SUPPORT = 4;

/**
 * The shared clamp with this module's policy in front of it.
 *
 * `clamp01` propagates NaN, which is right for a quantity and wrong for this
 * one: a part nobody could measure has to score nothing rather than poison the
 * minimum, because not knowing must never arrive as permission to invent.
 */
const unitOrNone = (v: number): number => (Number.isFinite(v) ? clamp01(v) : 0);

/**
 * A pixel's continuity support, in `[0, 1]`.
 *
 * Zero whenever any part is zero, so a pixel with no samples under it has no
 * support however complete the sweep is and however well its neighbours agree.
 */
export function continuitySupport(input: SupportInput): number {
  const samples = Number.isFinite(input.directSamples) ? Math.max(0, input.directSamples) : 0;
  const sampleTerm = unitOrNone(samples / SAMPLES_FOR_FULL_SUPPORT);

  const contributed = Number.isFinite(input.phasesContributed)
    ? Math.max(0, input.phasesContributed)
    : 0;
  const sweepTerm = unitOrNone(contributed / input.phaseCount);

  const coherenceTerm = unitOrNone(input.neighbourCoherence);

  return Math.min(sampleTerm, sweepTerm, coherenceTerm);
}

/**
 * The support a pixel needs before the renderer may fill it.
 *
 * A starting value, not a measured one, and deliberately high: the cost of
 * refusing is a visible gap, and the cost of allowing wrongly is a surface that
 * was never there. The first is honest and the second is not, so the threshold
 * errs toward the gap.
 */
export const MIN_SUPPORT_TO_RECONSTRUCT = 0.75;

/** Whether a pixel is backed well enough to fill. */
export function mayReconstruct(
  support: number,
  threshold: number = MIN_SUPPORT_TO_RECONSTRUCT,
): boolean {
  return Number.isFinite(support) && support >= threshold;
}
