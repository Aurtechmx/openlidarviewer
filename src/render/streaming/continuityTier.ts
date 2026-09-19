/**
 * continuityTier.ts
 *
 * How far the Continuity Field is allowed to go, and what it falls back to when
 * a backend cannot carry the whole thing.
 *
 * Degrading has one rule that matters: a lower rung may do less than a higher
 * one, never something different. A ladder that swapped one capability for
 * another as it descended would change what a viewer is looking at rather than
 * simplify it, and two machines would then disagree about the picture for
 * reasons neither could see. Each rung's capabilities are a subset of the rung
 * above, and a test holds the ladder to that rather than the comment.
 *
 * The lens is not a rung. Reconstruction is the field putting pixels on screen
 * that no point was recorded at, and the lens is the only way to see which
 * those are, so it comes on with reconstruction and cannot be traded away for
 * performance. A tier that reconstructed without it would be a viewer that
 * invents geometry and offers no way to check, which is worse than the tier
 * below it doing less.
 *
 * The bottom rung is the renderer as it ships today. A backend that can carry
 * none of this still draws the cloud, because nothing here is worth failing a
 * viewer over.
 *
 * Pure: no three.js, no device queries. The caller detects what a backend
 * supports and asks. Display only.
 */
import type { ContinuityCapabilities } from '../continuity/continuityField';

/** The rungs, richest first. */
export type ContinuityTier =
  /** Everything: accumulation, gap closure, coverage sizing. */
  | 'full'
  /** Gap closure and coverage sizing, with no history kept between frames. */
  | 'closure'
  /** Coverage sizing alone. Nothing is reconstructed. */
  | 'sizing'
  /** The renderer as it ships today. */
  | 'source';

/** Richest first, so a descent is a walk along this. */
export const TIER_ORDER: readonly ContinuityTier[] = ['full', 'closure', 'sizing', 'source'];

/**
 * What a backend can carry. Reported by whoever asked the device, not guessed
 * from a name: the programme forbids brand lists, and a model string says
 * nothing reliable about a driver.
 */
export interface BackendSupport {
  /** Can history textures be allocated and read back across frames? */
  readonly historyTextures: boolean;
  /** Is there room for the history at the current backing store? */
  readonly historyFits: boolean;
  /** Can a pass read neighbouring depths, which gap closure needs? */
  readonly depthNeighbourhood: boolean;
}

/**
 * The capabilities a rung turns on.
 *
 * `nodeCulling` and `packedAttributes` are absent from every rung on purpose.
 * They change how much work is done, not what is drawn, so they are not part of
 * a visual ladder and are gated on their own evidence.
 */
export function capabilitiesForTier(tier: ContinuityTier): ContinuityCapabilities {
  const off: ContinuityCapabilities = {
    nodeCulling: false,
    packedAttributes: false,
    coverageSizing: false,
    microGapFill: false,
    temporalAccumulation: false,
    evidenceLens: false,
  };
  switch (tier) {
    case 'full':
      return { ...off, coverageSizing: true, microGapFill: true, temporalAccumulation: true, evidenceLens: true };
    case 'closure':
      return { ...off, coverageSizing: true, microGapFill: true, evidenceLens: true };
    case 'sizing':
      return { ...off, coverageSizing: true };
    case 'source':
      return off;
  }
}

/**
 * The highest rung a backend can carry.
 *
 * Each condition removes what it cannot support and nothing else. A backend
 * with room for no history still closes gaps; one that cannot read neighbouring
 * depths cannot, and falls to sizing.
 */
export function tierFor(support: BackendSupport): ContinuityTier {
  if (!support.depthNeighbourhood) return 'sizing';
  if (!support.historyTextures || !support.historyFits) return 'closure';
  return 'full';
}

/** The next rung down, or null at the bottom. */
export function degrade(tier: ContinuityTier): ContinuityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i < 0 || i >= TIER_ORDER.length - 1 ? null : TIER_ORDER[i + 1];
}
