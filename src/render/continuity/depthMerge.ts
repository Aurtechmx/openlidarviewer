/**
 * depthMerge.ts
 *
 * Whether a new sample replaces, joins, or loses to what the accumulation
 * history already holds at a pixel.
 *
 * This is not photographic accumulation. Blending a point cloud by colour alone
 * would average a foreground sample with the background visible between its
 * neighbours, inventing a surface in the gap. The history therefore carries
 * depth, and a sample only joins what is already there when the two are on the
 * same surface. Otherwise the nearer one wins outright.
 *
 * Depth is compared as a ratio, not a difference. A fixed tolerance in world
 * units is far too loose near the camera and far too tight across a valley, so
 * the same number cannot serve both ends of a scene. Comparing logarithms makes
 * the tolerance proportional: `|log2(zs) - log2(zh)| < epsilon` holds when the
 * two depths are within a fixed fraction of each other wherever they sit, which
 * is the behaviour a point cloud spanning metres to kilometres needs.
 *
 * Pure: no three.js, no GPU. The caller owns the buffers and performs the merge;
 * this decides only which of the four outcomes applies. Display only. An
 * accumulated pixel is not a measurement and never becomes one.
 */

/**
 * Whether a colour mode's values mean a quantity or a name.
 *
 * The same honesty gate the colour modes already apply, carried into
 * accumulation. Classification and point source id are categorical: the numbers
 * are labels, and a value between two of them is not a value at all. Painting
 * unordered ids on a ramp would invent an ordering the data does not have, and
 * averaging two class colours across frames invents a class, which is the same
 * mistake arriving through time rather than through a palette.
 */
export type ColorSemantics =
  /** A scalar where an intermediate value means something. Elevation, intensity. */
  | 'continuous'
  /** A label where it does not. Classification, point source id. */
  | 'categorical';

/** What to do with a new sample at a pixel. */
export type MergeDecision =
  /** Nothing there yet. Take the sample. */
  | 'accept'
  /** The sample is in front of the history by more than the tolerance. */
  | 'replace'
  /**
   * Same surface within tolerance. Add the sample's colour and support.
   *
   * Never returned for categorical colour: two samples on one surface may carry
   * different labels, and the honest answers are to take one of them, not to
   * make a third.
   */
  | 'blend'
  /** The sample is behind the history. Keep what is there. */
  | 'keep';

/**
 * Default depth tolerance, in log2 units. 0.02 admits depths within about 1.4
 * percent of each other, which holds a sampled surface together without
 * reaching across the gap to whatever is behind it. It is a starting value, not
 * a measured one: the figure that survives contact with near geometry and
 * distant terrain has to come from a real scene.
 */
export const DEFAULT_DEPTH_EPSILON = 0.02;

/**
 * Whether two depths describe the same local surface.
 *
 * Non-positive or non-finite depths are never compatible. A depth of zero or
 * less is behind the eye and has no logarithm, and letting one through would
 * make `log2` return negative infinity, whose difference with anything is either
 * infinite or NaN. NaN fails every comparison, so the test would silently answer
 * "not compatible" for a reason that has nothing to do with the surfaces.
 */
export function depthCompatible(
  sampleZ: number,
  historyZ: number,
  epsilon: number = DEFAULT_DEPTH_EPSILON,
): boolean {
  if (!(sampleZ > 0) || !(historyZ > 0)) return false;
  if (!Number.isFinite(sampleZ) || !Number.isFinite(historyZ)) return false;
  return Math.abs(Math.log2(sampleZ) - Math.log2(historyZ)) < epsilon;
}

/**
 * The outcome for one sample against the history at its pixel.
 *
 * `historyWeight` at or below zero means the pixel is empty, whatever the
 * history depth says, so a buffer that was cleared to a stale depth cannot make
 * a first sample lose to nothing.
 */
export function mergeDecision(
  sampleZ: number,
  historyZ: number,
  historyWeight: number,
  epsilon: number = DEFAULT_DEPTH_EPSILON,
  semantics: ColorSemantics = 'continuous',
): MergeDecision {
  if (!(historyWeight > 0)) return 'accept';
  if (!(sampleZ > 0) || !Number.isFinite(sampleZ)) return 'keep';
  if (depthCompatible(sampleZ, historyZ, epsilon)) {
    if (semantics === 'continuous') return 'blend';
    // Categorical: one of the two labels, never a colour between them. The
    // nearer sample wins and an exact tie keeps what is already there, so a
    // surface carrying two classes settles on one rather than alternating
    // between them frame after frame.
    return sampleZ < historyZ ? 'replace' : 'keep';
  }
  return sampleZ < historyZ ? 'replace' : 'keep';
}
