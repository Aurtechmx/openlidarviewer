/**
 * continuityRequest.ts — what the flags are asking for, in one rung.
 *
 * The flag surface is six independent switches, which is sixty-four
 * combinations, and only four of them were ever designed: the tier ladder,
 * each rung a superset of the one below. `devFlags` says as much already, and
 * saying it is not the same as offering a way to ask for a rung. Without one,
 * the only way to run `closure` is to set three switches and know which three,
 * and the way to run it wrongly is to set two.
 *
 * `?continuityTier=` is that way. The six switches stay, because a switch is
 * how a combination gets bisected when a rung misbehaves, and they can only
 * add: a switch never takes a capability away from the rung that was asked
 * for, so `?continuityTier=closure&continuityEvidenceLens=0` is still closure.
 * Removing capabilities from a rung is how the sixty-four combinations come
 * back.
 *
 * Both surfaces reach the same two answers, computed here and nowhere else.
 * The rung asked for is the richer of what the dial says and what the switches
 * imply, so a bisecting switch on its own still does something; the opt-in is
 * the union, so a rung always carries its own capabilities whether or not the
 * matching switch was set.
 *
 * Pure. It parses nothing: `devFlags` owns the URL, as it does for every other
 * flag.
 */
import {
  capabilitiesForTier,
  TIER_ORDER,
  type ContinuityTier,
} from './continuityTier';
import { grantedTier, tierCeilingFor, tierPermittedBy, type CapabilityOptIn } from './mobilePolicy';

/**
 * The continuity half of the dev flags as `devFlags` names them.
 *
 * Structural, so a caller passes the flag record it already read rather than
 * transcribing six fields and possibly transcribing one wrongly.
 */
export interface ContinuityDevFlags {
  readonly continuityTier: ContinuityTier;
  readonly continuityCoverageSizing: boolean;
  readonly continuityMicroGapFill: boolean;
  readonly continuityTemporalAccumulation: boolean;
  readonly continuityEvidenceLens: boolean;
}

/** The same flags under the names the rest of this directory uses. */
export function continuityFlagsOf(dev: ContinuityDevFlags): ContinuityFlags {
  return {
    tier: dev.continuityTier,
    coverageSizing: dev.continuityCoverageSizing,
    microGapFill: dev.continuityMicroGapFill,
    temporalAccumulation: dev.continuityTemporalAccumulation,
    evidenceLens: dev.continuityEvidenceLens,
  };
}

/** The continuity half of the dev flags, already parsed. */
export interface ContinuityFlags {
  /** The rung asked for. */
  readonly tier: ContinuityTier;
  readonly coverageSizing: boolean;
  readonly microGapFill: boolean;
  readonly temporalAccumulation: boolean;
  readonly evidenceLens: boolean;
}

/** What the runtime is asked for. */
export interface ContinuityRequest {
  /** The rung to request. A request, never a grant. */
  readonly requested: ContinuityTier;
  /** Which capabilities this session has opted into at all. */
  readonly optIn: CapabilityOptIn;
}

/** The richer of two rungs, by the ladder's own order. */
function richer(a: ContinuityTier, b: ContinuityTier): ContinuityTier {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

/** Nothing asked for: the renderer as it shipped. */
export const NO_REQUEST: ContinuityRequest = {
  requested: 'source',
  optIn: {
    coverageSizing: false,
    microGapFill: false,
    temporalAccumulation: false,
    evidenceLens: false,
  },
};

/**
 * The rung and the opt-in a set of flags asks for.
 *
 * With no flag set at all this is {@link NO_REQUEST}, which every device
 * resolves to `source`. That is the shipped configuration, and it is a
 * property of the flags rather than of the hardware: a machine that could
 * carry the whole ladder still runs the renderer as it shipped until
 * something asks otherwise.
 */
export function continuityRequest(flags: ContinuityFlags): ContinuityRequest {
  const switches: CapabilityOptIn = {
    coverageSizing: flags.coverageSizing,
    microGapFill: flags.microGapFill,
    temporalAccumulation: flags.temporalAccumulation,
    evidenceLens: flags.evidenceLens,
  };
  const requested = richer(flags.tier, tierPermittedBy(switches));
  const fromTier = capabilitiesForTier(requested);
  return {
    requested,
    optIn: {
      coverageSizing: switches.coverageSizing || fromTier.coverageSizing,
      microGapFill: switches.microGapFill || fromTier.microGapFill,
      temporalAccumulation: switches.temporalAccumulation || fromTier.temporalAccumulation,
      evidenceLens: switches.evidenceLens || fromTier.evidenceLens,
    },
  };
}

/**
 * Whether this session was granted coverage sizing.
 *
 * The one capability that needs nothing per-frame: no history, no epoch and no
 * sweep, only a uniform that says the frontier should be sized for what it
 * covers. So it is answered once, from the flags and the device class, rather
 * than through the runtime's per-frame plan.
 *
 * The backend term is `sizing` because `tierFor` never answers below it: every
 * backend can size points, so nothing a probe could report would lower a
 * request for this rung. Passing it also caps the answer there, so this
 * function cannot grant a capability from a richer rung by accident.
 */
export function coverageSizingGranted(dev: ContinuityDevFlags, touchFirst: boolean): boolean {
  const { requested, optIn } = continuityRequest(continuityFlagsOf(dev));
  const granted = grantedTier(requested, 'sizing', tierCeilingFor(touchFirst), optIn);
  return capabilitiesForTier(granted).coverageSizing;
}
