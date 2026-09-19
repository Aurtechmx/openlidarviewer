/**
 * mobilePolicy.ts
 *
 * What the Continuity Field is allowed to do on a touch-first device, and how
 * the history it keeps coordinates with a pixel ratio that moves underneath it.
 *
 * The coordination is not optional and it is not cosmetic. `setPixelRatio`
 * reallocates the drawing buffer, which is why `adaptiveDpr` rate-limits its
 * reductions; the history keeps three surfaces sized to that same backing
 * store, so a ratio that moves takes the history with it. Sizing the history
 * from whatever ratio is in force this frame would free and reallocate three
 * surfaces on every motion episode, and worse, it would do it at exactly the
 * wrong moment: the ratio snaps back to full the instant the camera parks, and
 * parking is when a sweep begins. The history would be discarded on the frame
 * it was about to be used.
 *
 * So the history is sized from the PARKED ratio and ignores the motion-time
 * reductions. Nothing is lost by that. Reductions only happen while the camera
 * is moving, and a moving camera has no sweep to accumulate: convergence needs
 * a fully refined view. The reduced frames are the ones the history is not
 * being written from anyway.
 *
 * The bound under a high ratio is solved rather than chosen. `historyBudget`
 * already sets the ceiling past which a history is not worth allocating, and
 * the cost is the backing store area times the bytes a pixel costs, so the
 * largest ratio that fits follows from those two by arithmetic. A phone at a
 * ratio of three gets a history at whatever ratio its viewport can afford, and
 * the answer comes from the same ceiling a desktop is held to.
 *
 * What that bound must never do is lower the RENDER ratio. The history is a
 * display enhancement and the render target is the picture; degrading the
 * picture so an enhancement of it can be afforded has the relationship
 * backwards. The history takes a ratio at or below the render ratio, and where
 * even one device pixel per CSS pixel will not fit it declines, which the tier
 * ladder already knows how to absorb through `historyFits`.
 *
 * The mobile ceiling is the tier ladder's, not a second ladder. A touch-first
 * device is capped at coverage sizing, which is the rung that reconstructs
 * nothing and keeps no history. Accumulation may rise above that cap only on
 * measured frame evidence from the device class in question, and no such
 * measurement exists: this programme has no phone, tablet or iPhone-class
 * WebKit runner, so the cap is where it stays. Taking the cap off on the
 * grounds that the memory arithmetic works would be answering the frame-budget
 * question with the memory-budget answer.
 *
 * Touch-first is taken as a fact rather than decided here, from
 * `isTouchFirstDevice`, which asks the pointer whether it is coarse and
 * hoverless instead of reading a model name. The programme forbids brand lists
 * and a user-agent string says nothing reliable about a GPU.
 *
 * Pure arithmetic and policy: no GPU, no DOM, no allocation.
 */
import { DPR_MOTION_FLOOR, DPR_QUANT_STEP } from '../adaptiveDpr';
import {
  bytesPerPixel,
  historyFits,
  CONSERVATIVE_LAYOUT,
  HISTORY_BYTES_CEILING,
  type HistoryLayout,
} from './historyBudget';
import { TIER_ORDER, capabilitiesForTier, type ContinuityTier } from './continuityTier';
import type { ContinuityCapabilities } from './continuityField';

/**
 * The pixel ratio the history is sized at.
 *
 * Takes the parked ratio and ignores the one in force this frame. The current
 * ratio is accepted anyway so the signature says what it is coordinating with,
 * and so a caller cannot pass the wrong one by passing the only one it has.
 */
export function historyPixelRatio(parkedDpr: number, _currentDpr: number): number {
  return Number.isFinite(parkedDpr) && parkedDpr > 0 ? parkedDpr : 1;
}

/**
 * The largest pixel ratio whose history fits the budget ceiling, for a viewport
 * measured in CSS pixels.
 *
 * Cost is `w·r · h·r · bytesPerPixel`, so the ratio that exactly spends the
 * ceiling is the square root of `ceiling / (w·h·bytesPerPixel)`. Quantised DOWN
 * onto the same grid `adaptiveDpr` snaps to, so the two never ask for backing
 * stores a quarter-step apart, and rounding down rather than to nearest because
 * a ratio that rounds up does not fit.
 *
 * Returns 0 when nothing fits, including at the floor. That is not a ratio and
 * is not meant to be used as one: it is the signal that this viewport gets no
 * history, which `historyFits` reports to the tier ladder.
 */
export function historyDprCeiling(
  widthCssPx: number,
  heightCssPx: number,
  layout: HistoryLayout = CONSERVATIVE_LAYOUT,
  ceiling: number = HISTORY_BYTES_CEILING,
): number {
  const w = Number.isFinite(widthCssPx) ? Math.floor(widthCssPx) : 0;
  const h = Number.isFinite(heightCssPx) ? Math.floor(heightCssPx) : 0;
  if (w <= 0 || h <= 0) return 0;
  const bpp = bytesPerPixel(layout);
  if (!(bpp > 0) || !Number.isFinite(ceiling) || ceiling <= 0) return 0;
  const exact = Math.sqrt(ceiling / (w * h * bpp));
  const quantised = Math.floor(exact / DPR_QUANT_STEP) * DPR_QUANT_STEP;
  if (quantised < DPR_MOTION_FLOOR) {
    // Below one device pixel per CSS pixel the history would be a blur of the
    // picture rather than a record of it, so there is no history at all.
    return historyFits(w, h, layout, ceiling) ? DPR_MOTION_FLOOR : 0;
  }
  return quantised;
}

/**
 * The ratio the history is actually allocated at: the parked ratio, held under
 * the budget ceiling, and never above the ratio the picture is rendered at.
 *
 * Zero means no history fits this viewport.
 */
export function allocatedHistoryDpr(
  parkedDpr: number,
  widthCssPx: number,
  heightCssPx: number,
  layout: HistoryLayout = CONSERVATIVE_LAYOUT,
  ceiling: number = HISTORY_BYTES_CEILING,
): number {
  const wanted = historyPixelRatio(parkedDpr, parkedDpr);
  const affordable = historyDprCeiling(widthCssPx, heightCssPx, layout, ceiling);
  if (affordable <= 0) return 0;
  return Math.min(wanted, affordable);
}

/**
 * Measured evidence that a device class can carry a rung above the mobile cap.
 *
 * A record of a benchmark rather than a threshold: the caller names the class
 * it measured and what it saw. Nothing in the tree constructs one, because
 * nothing in the tree has run on a phone.
 */
export interface MobileFrameEvidence {
  /** What was measured, in the words of whoever measured it. */
  readonly deviceClass: string;
  /** The rung that was measured to hold its frame budget on that class. */
  readonly sustainedTier: ContinuityTier;
}

/** The rung a touch-first device is capped at with no measurement to raise it. */
export const MOBILE_DEFAULT_CEILING: ContinuityTier = 'sizing';

/** The lower of two rungs, by the ladder's own order. */
export function lowerTier(a: ContinuityTier, b: ContinuityTier): ContinuityTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * The ceiling a device class puts on the tier ladder.
 *
 * A desktop has no ceiling from this policy and is decided by its backend
 * alone. A touch-first device is capped at coverage sizing unless evidence
 * names a higher sustained rung for it, and evidence for a different rung than
 * the one being asked about raises nothing.
 */
export function tierCeilingFor(
  touchFirst: boolean,
  evidence?: MobileFrameEvidence | null,
): ContinuityTier {
  if (!touchFirst) return 'full';
  if (!evidence) return MOBILE_DEFAULT_CEILING;
  const measured = evidence.sustainedTier;
  if (TIER_ORDER.indexOf(measured) < 0) return MOBILE_DEFAULT_CEILING;
  // Evidence may only raise the cap, never lower one the ladder already set.
  return TIER_ORDER.indexOf(measured) <= TIER_ORDER.indexOf(MOBILE_DEFAULT_CEILING)
    ? measured
    : MOBILE_DEFAULT_CEILING;
}

/**
 * The rung to run at: what the backend can carry, held under what the device
 * class is allowed.
 *
 * The ceiling never raises a tier. A backend that cannot keep a history is at
 * closure whatever policy permits, because permission is not capability.
 */
export function tierUnderPolicy(
  backendTier: ContinuityTier,
  ceiling: ContinuityTier,
): ContinuityTier {
  return lowerTier(backendTier, ceiling);
}

/**
 * The capabilities a session has explicitly opted into.
 *
 * Taken as a fact rather than read from the flag store here, which keeps this
 * module pure and keeps one place responsible for parsing a URL. The shape
 * mirrors the display half of `ContinuityCapabilities`; loader capabilities are
 * absent because they change how data is carried rather than how it looks, and
 * they are gated on their own evidence.
 */
export interface CapabilityOptIn {
  readonly coverageSizing: boolean;
  readonly microGapFill: boolean;
  readonly temporalAccumulation: boolean;
  readonly evidenceLens: boolean;
}

/** Nothing opted into, which is what a session has until a flag says otherwise. */
export const NO_OPT_IN: CapabilityOptIn = {
  coverageSizing: false,
  microGapFill: false,
  temporalAccumulation: false,
  evidenceLens: false,
};

/**
 * The richest rung every one of whose capabilities has been opted into.
 *
 * Walks the ladder from the top and takes the first rung that asks for nothing
 * unopted. A rung is all-or-nothing on purpose: granting the half of `full`
 * that happens to be enabled would run a configuration nobody chose and nobody
 * measured, which is worse than running the rung below it.
 */
export function tierPermittedBy(optIn: CapabilityOptIn): ContinuityTier {
  for (const tier of TIER_ORDER) {
    const wanted = capabilitiesForTier(tier);
    if (
      (!wanted.coverageSizing || optIn.coverageSizing)
      && (!wanted.microGapFill || optIn.microGapFill)
      && (!wanted.temporalAccumulation || optIn.temporalAccumulation)
      && (!wanted.evidenceLens || optIn.evidenceLens)
    ) {
      return tier;
    }
  }
  return 'source';
}

/**
 * The rung a viewer actually runs, from all three things that can lower it.
 *
 * One call rather than three composed by each caller, because the failure this
 * guards against is a caller applying two of the caps and forgetting the third.
 * With nothing opted into, every input combination returns `source`, which is
 * what keeps the Continuity Field off by default while its evidence is
 * outstanding: the release decision is a flag, not a property of the device
 * that happens to be running it.
 */
export function grantedTier(
  requested: ContinuityTier,
  backendTier: ContinuityTier,
  ceiling: ContinuityTier,
  optIn: CapabilityOptIn,
): ContinuityTier {
  return lowerTier(
    lowerTier(requested, backendTier),
    lowerTier(ceiling, tierPermittedBy(optIn)),
  );
}

/** The capabilities a viewer actually runs with. */
export function grantedCapabilities(
  requested: ContinuityTier,
  backendTier: ContinuityTier,
  ceiling: ContinuityTier,
  optIn: CapabilityOptIn,
): ContinuityCapabilities {
  return capabilitiesForTier(grantedTier(requested, backendTier, ceiling, optIn));
}
